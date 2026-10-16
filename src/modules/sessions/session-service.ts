import { logDiagnostic } from '../logging/index.ts'
import { UiPreferenceRepository } from "../ui-preferences/index.ts"
import { withAccount } from '../accounts/index.ts'
import { randomUUID } from 'node:crypto'
import { toJson, QQ_FILE_MAX_INPUT_BYTES } from '@eden/api'
import type { JsonValue, AttachmentRef, AttachmentSnapshot } from '@eden/api'
import { createIsolatedRuntime as createRuntime } from '@eden/runtime-pi'
import type { EdenRuntime, RuntimeModel, RuntimeTool } from '@eden/runtime-pi'
import type { AcceptedInput, SessionInput, SessionTurnExtension, SessionBoundary } from './contracts.ts'
import { SessionRepository } from './session-repository.ts'
import { InputRepository } from './input/input-repository.ts'
import { runtimeCallbacks } from './turn/runtime-callbacks.ts'
import { sessionPromptContent } from './turn/session-prompt.ts'
import { SignalRepository } from './input/signal-repository.ts'
import { modelDescriptor, assertModelSnapshot } from './turn/model-snapshot.ts'
import { inputAttachments, type AttachmentService } from '../attachments/index.ts'
import { InputAdmissions } from './input/admissions.ts'
import { InputResubmissionRepository } from './input/resubmission-repository.ts'
import type { MemoryRecall } from '../memories/index.ts'
import { SessionTitleService } from './session-title-service.ts'
import { runtimeStopReason, transientTurnInput, turnRecallQuery } from './turn/single-turn-context.ts'
import { SessionFaults, sessionFailureReason } from './session-faults.ts'
import { recoverSessionStorage } from './session-storage-recovery.ts'

export class SessionService {
  private readonly inputs: InputRepository
  private readonly signals: SignalRepository
  private readonly turns = new Map<string, string>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly runtimes = new Map<string, EdenRuntime>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly stopping = new Set<string>()
  private readonly editing = new Set<string>()
  private readonly boundaryWaiting = new Set<string>()
  private descendantStop: ((sessionId: string) => Promise<void>) | undefined
  private endCleanup: ((sessionId: string) => Promise<void>) | undefined
  private closed = false
  private readonly faults: SessionFaults
  private readonly admissions = new InputAdmissions()
  private readonly titles: SessionTitleService

  constructor(readonly repository: SessionRepository, private readonly model: RuntimeModel | ((sessionId: string) => RuntimeModel | undefined) | undefined,
    private readonly tools: (sessionId: string, turnId: string) => RuntimeTool[] = () => [],
    private readonly participantsChanged: (sessionId: string) => void = () => { },
    private readonly extension?: SessionTurnExtension, private readonly boundary?: SessionBoundary,
    private readonly attachments?: AttachmentService, private readonly memoryRecall?: MemoryRecall) {
    this.inputs = new InputRepository(repository.database, repository.events)
    this.signals = new SignalRepository(repository.database, repository.events)
    this.faults = new SessionFaults((sessionId, reason) => recoverSessionStorage(repository, this.inputs, this.signals, sessionId, reason,
      () => this.extension?.validateCheckpoints?.(sessionId)))
    this.titles = new SessionTitleService(repository, sessionId => this.resolveModel(sessionId))
    this.signals.interrupt()
    for (const sessionId of this.inputs.interruptedSessions()) this.stopping.add(sessionId)
    this.inputs.recoverInterrupted()
  }

  resumePending(): void {
    if (this.closed) return
    for (const sessionId of new Set([...this.inputs.pendingSessions(), ...this.boundary?.pendingSessions() ?? []])) {
      if (this.stopping.has(sessionId) || this.faults.has(sessionId) || !this.repository.ownership.visible(sessionId)) continue
      const participants = this.repository.read(sessionId).participants
      const available = participants.length > 1 ? this.extension?.snapshot(sessionId, participants) : this.resolveModel(sessionId)
      if (available) { this.boundaryWaiting.delete(sessionId); this.wake(sessionId) }
    }
  }

  private resolveModel(sessionId: string): RuntimeModel | undefined { return typeof this.model === 'function' ? this.model(sessionId) : this.model }

  start(sessionId: string, text: string, idempotencyKey: string = randomUUID(), environment?: JsonValue, kind: 'prompt' | 'compact' = 'prompt'): AcceptedInput {
    return this.accept(sessionId, text, idempotencyKey, environment, kind)
  }
  resubmissionPreview(sessionId: string, sourceId: string) {
    const { snapshots: _snapshots, ...source } = new InputResubmissionRepository(this.repository).source(sessionId, sourceId)
    return source
  }
  resubmit(sessionId: string, sourceId: string, fingerprint: string, note: string): Promise<AcceptedInput> {
    const recovery = new InputResubmissionRepository(this.repository)
    const previous = recovery.existing(sessionId, sourceId, fingerprint, note)
    if (previous) return Promise.resolve(previous)
    const source = recovery.source(sessionId, sourceId)
    if (source.fingerprint !== fingerprint) return Promise.reject(new Error('Source input changed; preview again'))
    this.repository.assertContextReady(sessionId)
    const captured = JSON.stringify(this.inputMetadata(sessionId, source.environment))
    return this.admissions.submit(sessionId, async signal => {
      if (source.attachments.length && !this.attachments) throw new Error('Attachment service unavailable')
      const snapshots = source.attachments.length ? await this.attachments!.snapshot(source.attachments, this.attachmentBudget(sessionId)) : []
      if (source.snapshots.length && JSON.stringify(snapshots) !== JSON.stringify(source.snapshots)) throw new Error('Original attachment snapshots no longer match')
      signal.throwIfAborted()
      const existing = recovery.existing(sessionId, sourceId, fingerprint, note)
      if (existing) return existing
      if (JSON.stringify(this.inputMetadata(sessionId, source.environment)) !== captured) throw new Error('Current session configuration changed; preview again')
      return this.accept(sessionId, source.text, `resubmit:${sourceId}`, source.environment, source.kind, snapshots,
        accepted => recovery.record(sessionId, sourceId, fingerprint, note, accepted))
    })
  }

  submitJob(sessionId: string, text: string, jobId: string, jobKind: string, onCommit: (input: AcceptedInput) => void, recallQuery?: string): AcceptedInput {
    const metadata = { ...this.inputMetadata(sessionId, undefined, false), job: { id: jobId, kind: jobKind }, ...(recallQuery === undefined ? {} : { recallQuery }) }
    const accepted = this.inputs.enqueue(sessionId, text, `job:${jobId}`, metadata, 'prompt', undefined, onCommit)
    this.stopping.delete(sessionId)
    this.boundaryWaiting.delete(sessionId)
    this.wake(sessionId)
    return accepted
  }

  startWithAttachments(sessionId: string, text: string, references: readonly AttachmentRef[], idempotencyKey: string = randomUUID(), environment?: JsonValue, onCommit?: (input: AcceptedInput) => void): Promise<AcceptedInput> {
    const captured = structuredClone(this.inputMetadata(sessionId, environment))
    if (!this.attachments) return Promise.reject(new Error('Attachment service unavailable'))
    const refs = structuredClone(references)
    const savedEnvironment = environment === undefined ? undefined : structuredClone(environment)
    return this.admissions.submit(sessionId, async signal => {
      const snapshots = await this.attachments!.snapshot(refs, this.attachmentBudget(sessionId))
      signal.throwIfAborted()
      if (JSON.stringify(this.inputMetadata(sessionId, savedEnvironment)) !== JSON.stringify(captured)) throw new Error('Session configuration changed during attachment validation; resubmit')
      return this.accept(sessionId, text, idempotencyKey, savedEnvironment, 'prompt', snapshots, onCommit)
    })
  }

  private inputMetadata(sessionId: string, environment?: JsonValue, allowRecovery = true) {
    if (this.closed) throw new Error('Server is shutting down')
    if (this.editing.has(sessionId)) throw new Error('Session is being closed or deleted')
    if (this.stopping.has(sessionId) && this.tasks.has(sessionId)) throw new Error('Session is stopping; wait for the current turn to finish')
    this.repository.ownership.assert(sessionId)
    this.faults.assertCanSubmit(sessionId, allowRecovery)
    const session = this.repository.read(sessionId)
    if (session.status !== 'active') throw new Error('Session is closed')
    const preferences = new UiPreferenceRepository(this.repository.database)
    const replyLengths = Object.fromEntries(session.participants.map(participant => {
      const value = participant && typeof participant === 'object' && !Array.isArray(participant) ? participant : {}
      const id = String(value.characterId ?? value.characterID ?? '')
      return [id, preferences.replyLength(id).length]
    }))
    return { replyLengths, participants: session.participants, environment: environment === undefined ? session.environment : environment,
      ...(session.sourceChannel === 'qq' ? { sourceChannel: 'qq' } : {}), ...this.executionSnapshot(sessionId, session.participants) }
  }

  private accept(sessionId: string, text: string, idempotencyKey: string, environment: JsonValue | undefined, kind: 'prompt' | 'compact', attachments: AttachmentSnapshot[] = [], onCommit?: (input: AcceptedInput) => void): AcceptedInput {
    const metadata = { ...this.inputMetadata(sessionId, environment), ...(attachments.length ? { attachments: toJson(attachments) } : {}) }
    const result = this.inputs.enqueue(sessionId, text, idempotencyKey, metadata, kind,
      environment === undefined ? undefined : { participants: metadata.participants, environment }, onCommit)
    if (kind === 'prompt') this.titles.schedule(sessionId, result.turnId, text)
    this.stopping.delete(sessionId)
    this.boundaryWaiting.delete(sessionId)
    this.wake(sessionId)
    return result
  }

  private executionSnapshot(sessionId: string, participants: JsonValue[]) {
    if (participants.length > 1) {
      const companion = this.extension?.snapshot(sessionId, participants)
      if (!companion) throw new Error('No model configured for all session actors')
      return { companion }
    }
    const model = this.resolveModel(sessionId)
    if (!model) throw new Error('No model configured for this session')
    return { model: modelDescriptor(model) }
  }

  private wake(sessionId: string): void {
    if (this.tasks.has(sessionId)) return
    let account: ReturnType<SessionRepository['ownership']['account']>
    const task = Promise.resolve().then(() => {
      account = this.repository.ownership.account(sessionId)
      if (this.repository.origin === 'mon' && !account) throw new Error('会话账号归属尚未确认，已暂停执行')
      return withAccount(account, () => this.drain(sessionId))
    }).catch(error => {
      this.stopping.add(sessionId)
      let failure = error
      try { withAccount(account, () => { this.repository.ownership.assert(sessionId); this.inputs.holdQueued(sessionId, sessionFailureReason(error)) }) }
      catch (storageError) { failure = new AggregateError([error, storageError], '会话暂停失败', { cause: storageError }) }
      const storage = this.faults.record(sessionId, failure)
      logDiagnostic({ event: storage ? 'session.halted' : 'session.execution.failed',
        message: storage ? '会话因存储故障暂停。' : '本轮执行失败，允许提交新输入。', origin: this.repository.origin, sessionId, error: failure }, 'error')
    }).finally(() => {
      this.tasks.delete(sessionId)
      if (!this.closed && !this.stopping.has(sessionId) && !this.boundaryWaiting.has(sessionId) && !this.faults.has(sessionId) && this.inputs.hasPending(sessionId)) this.wake(sessionId)
    })
    this.tasks.set(sessionId, task)
  }

  private async drain(sessionId: string): Promise<void> {
    while (!this.closed && !this.stopping.has(sessionId)) {
      if (!await this.beforeNextInput(sessionId)) return
      if (this.closed || this.stopping.has(sessionId)) return
      const input = this.inputs.claim(sessionId)
      if (!input) break
      await this.execute(input)
    }
  }

  private async beforeNextInput(sessionId: string): Promise<boolean> {
    if (!this.boundary) return true
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    try {
      const ready = await this.boundary.run(sessionId, controller.signal)
      if (!ready) this.boundaryWaiting.add(sessionId)
      return ready
    } finally { this.controllers.delete(sessionId) }
  }

  private async execute(input: SessionInput): Promise<void> {
    let reason: string | undefined
    let failure: unknown
    const controller = new AbortController()
    this.controllers.set(input.sessionId, controller)
    try {
      if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) && Object.hasOwn(input.metadata, 'companion')) {
        if (!this.extension) throw new Error('Multi-actor execution is unavailable')
        this.turns.set(input.sessionId, input.turnId)
        await this.extension.execute(input, controller.signal)
      } else reason = await this.executeSingle(input)
    } catch (error) {
      reason = sessionFailureReason(error)
      if (error !== controller.signal.reason) failure = error
    } finally {
      try { await this.runtimes.get(input.sessionId)?.dispose?.() }
      catch (error) {
        failure = failure ? new AggregateError([failure, error], '会话执行与运行时清理失败', { cause: error }) : error
        reason ??= sessionFailureReason(error)
      }
      finally { this.runtimes.delete(input.sessionId); this.turns.delete(input.sessionId); this.controllers.delete(input.sessionId) }
    }
    try { this.signals.interrupt(input.turnId); this.inputs.finish(input, reason) }
    catch (error) {
      if (failure) logDiagnostic({ event: 'session.turn.failed', origin: this.repository.origin,
        sessionId: input.sessionId, turnId: input.turnId, error: failure }, 'error')
      throw error
    }
    if (reason) this.stopping.add(input.sessionId)
    if (failure) throw failure
  }

  private async executeSingle(input: SessionInput): Promise<string | undefined> {
    const model = this.resolveModel(input.sessionId)
    if (!model) throw new Error('No model configured for this session')
    assertModelSnapshot(input.metadata, model)
    const transientInput = transientTurnInput(input.metadata)
    const checkpoint = this.repository.checkpoint(input.sessionId)
    const images = await this.imagesFor(input)
    this.controllers.get(input.sessionId)?.signal.throwIfAborted()
    const context = sessionPromptContent(input.metadata ?? {})
    const recallQuery = turnRecallQuery(input)
    const memory = this.memoryRecall?.prompt(input.sessionId, input.turnId, recallQuery) ?? ''
    const runtime = createRuntime({
      sessionId: input.sessionId, systemPrompt: context.prompt + memory,
      contextSources: toJson([...context.sources, { kind: 'memory', title: '召回记忆', content: memory }]) as JsonValue[],
      model, tools: this.tools(input.sessionId, input.turnId), refreshTools: () => this.tools(input.sessionId, input.turnId), transientInput,
      callbacks: runtimeCallbacks(this.repository, input, { privateUserInput: transientInput }),
      ...(checkpoint ? { checkpoint } : {}),
    })
    this.runtimes.set(input.sessionId, runtime)
    this.turns.set(input.sessionId, input.turnId)
    const response = input.kind === 'compact' ? await runtime.compact(input.text) : await runtime.prompt(input.text, images)
    return runtimeStopReason(response)
  }

  private async imagesFor(input: SessionInput) {
    const snapshots = inputAttachments(input.metadata)
    if (!snapshots.length) return []
    if (!this.attachments) throw new Error('Attachment service unavailable')
    return this.attachments.images(snapshots, this.attachmentBudget(input.sessionId))
  }

  private attachmentBudget(sessionId: string): number | undefined {
    return this.repository.read(sessionId).sourceChannel === 'qq' ? QQ_FILE_MAX_INPUT_BYTES : undefined
  }

  setDescendantStop(handler: (sessionId: string) => Promise<void>): void { this.descendantStop = handler }
  setEndCleanup(handler: (sessionId: string) => Promise<void>): void { this.endCleanup = handler }

  private releaseEndedScope(sessionId: string): void {
    if (!this.endCleanup) return
    void Promise.resolve(this.tasks.get(sessionId)).then(() => this.endCleanup!(sessionId)).catch(error =>
      logDiagnostic({ event: 'session.cleanup.failed', message: '会话资源清理失败。', origin: this.repository.origin, sessionId, error }, 'error'))
  }

  async cancel(sessionId: string): Promise<boolean> {
    this.repository.read(sessionId)
    this.stopping.add(sessionId)
    this.titles.cancel(sessionId)
    const admissionCancelled = this.admissions.cancel(sessionId)
    const running = this.tasks.has(sessionId)
    this.controllers.get(sessionId)?.abort()
    const abortRuntime = this.runtimes.get(sessionId)?.abort()
    const stopDescendants = this.descendantStop?.(sessionId)
    let queuedCancelled = 0
    let queueFailure: unknown
    try { queuedCancelled = this.inputs.cancelQueued(sessionId) }
    catch (error) { queueFailure = error }
    const results = await Promise.allSettled([abortRuntime, stopDescendants])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (queueFailure) failures.push(queueFailure)
    if (failures.length) throw new AggregateError(failures, 'Session cancellation failed')
    return running || admissionCancelled || queuedCancelled > 0
  }

  async endSession(sessionId: string, state: 'closed' | 'deleted'): Promise<void> {
    if (this.editing.has(sessionId)) throw new Error('Session mutation already running')
    this.editing.add(sessionId)
    try {
      if (state === 'deleted') {
        this.repository.read(sessionId)
        this.stopping.add(sessionId)
        this.titles.cancel(sessionId)
        this.admissions.cancel(sessionId)
        this.controllers.get(sessionId)?.abort(new Error('Session deleted'))
        const turnId = this.turns.get(sessionId)
        if (turnId) this.signals.interrupt(turnId)
        this.repository.setStatus(sessionId, state)
        this.releaseEndedScope(sessionId)
        // An unresponsive model or child must not hold the delete RPC open.
        const runtime = this.runtimes.get(sessionId)
        if (runtime) void runtime.abort().catch(error => logDiagnostic({ event: 'session.abort.failed', message: '会话执行中止失败。', origin: this.repository.origin, sessionId, error }, 'error'))
        if (this.descendantStop) void this.descendantStop(sessionId).catch(error => logDiagnostic({ event: 'session.children.stop_failed', message: '会话的子任务停止失败。', origin: this.repository.origin, sessionId, error }, 'error'))
        return
      }
      await this.cancel(sessionId)
      await this.waitForIdle(sessionId)
      this.repository.setStatus(sessionId, state)
      this.releaseEndedScope(sessionId)
    } finally { this.editing.delete(sessionId) }
  }

  async configureWhileIdle<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.repository.read(sessionId)
    if (this.closed || this.tasks.has(sessionId) || this.admissions.has(sessionId) || this.editing.has(sessionId)) throw new Error('Wait for the session to become idle before configuration')
    this.editing.add(sessionId)
    try { return await work() }
    finally { this.editing.delete(sessionId) }
  }

  async setParticipants(sessionId: string, participants: JsonValue[]) {
    return this.configureWhileIdle(sessionId, async () => {
      const session = this.repository.setMetadata(sessionId, participants)
      this.participantsChanged(sessionId)
      return session
    })
  }

  async inject(sessionId: string, text: string, kind: 'steer' | 'follow_up'): Promise<AcceptedInput> {
    if (this.closed || this.editing.has(sessionId) || (this.stopping.has(sessionId) && this.tasks.has(sessionId))) throw new Error('Session is closing')
    const runtime = this.runtimes.get(sessionId)
    const turnId = this.turns.get(sessionId)
    if (!turnId) return this.start(sessionId, text)
    const inputId = this.signals.create(sessionId, turnId, kind, text)
    try {
      if (runtime) {
        if (kind === 'steer') await runtime.steer(text)
        else await runtime.followUp(text)
      } else if (!await this.extension?.inject?.(sessionId, text, kind)) {
        this.signals.setState(inputId, 'rejected')
        return this.start(sessionId, text)
      }
      this.signals.setState(inputId, 'injected')
      return { sessionId, turnId, inputId, state: 'queued' }
    } catch (error) { this.signals.setState(inputId, 'rejected'); throw error }
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.admissions.wait(sessionId)
    while (this.tasks.has(sessionId)) await this.tasks.get(sessionId)
  }
  isRunning(sessionId: string): boolean { return this.tasks.has(sessionId) }
  runningCount(): number { return this.tasks.size }
  faultCount(): number { return this.faults.size }
  toolCatalog() {
    return this.tools('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000').map(tool => {
      if (tool.parameters.type !== 'object') throw new Error(`Tool "${tool.name}" parameters must have an object root`)
      return {
        name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
        source: tool.source ?? 'builtin', version: tool.revision,
        namespace: tool.source ?? 'builtin', executionMode: tool.executionMode ?? 'sequential', exposure: tool.exposure ?? 'direct',
      }
    })
  }
  async close(): Promise<void> {
    this.closed = true
    const titles = this.titles.close()
    const admissions = this.admissions.close()
    for (const controller of this.controllers.values()) controller.abort()
    const aborts = await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.abort()))
    await Promise.all(this.tasks.values())
    await titles
    await admissions
    const failures = aborts.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime abort reported persistence failures')
  }
}
