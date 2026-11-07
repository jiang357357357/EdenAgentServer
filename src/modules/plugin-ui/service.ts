import { randomUUID } from 'node:crypto'
import { toJson } from '@eden/api'
import type { PluginUiCall, PluginUiReport, PluginUiDiagnostic, JsonValue } from '@eden/api'
import { currentAccount, withAccount } from '../accounts/index.ts'
import { resolveRuntimeTool, toolFailureOutcome } from '@eden/runtime-pi'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { InstalledPackageRepository } from '../plugin-market/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { SessionRepository, SessionService } from '../sessions/index.ts'
import { z } from 'zod'
import { PluginUiActionJournal } from './action-journal.ts'
import { ExtensionStateRepository } from './extension-state.ts'
import { PluginUiDiagnostics } from './diagnostics.ts'
import type { DocumentInvocation } from '../workspace/index.ts'

interface Pending { controller: AbortController; sessionId: string; fingerprint: string; promise: Promise<JsonValue>;
  action: PluginUiCall['action']; context: string; state: 'waiting' | 'approval' | 'running' }
const operationContext = (input: { pluginId: string; componentId: string; revision: string; viewId: string; sessionId?: string | undefined }) =>
  JSON.stringify([input.pluginId, input.componentId, input.revision, input.viewId, input.sessionId])
export class PluginUiService {
  private readonly journal: PluginUiActionJournal
  private readonly state: ExtensionStateRepository
  private readonly diagnostics = new PluginUiDiagnostics()
  private readonly pending = new Map<string, Pending>()
  private readonly completed = new Map<string, { sessionId: string; fingerprint: string; result: JsonValue }>()
  private readonly reports = new Map<string, { account: string; report: PluginUiReport; updatedAt: number }>()
  private catalog?: { stamp: string; value: { modules: Omit<ReturnType<InstalledPackageRepository['uiModules']>[number], 'source'>[];
    errors: { pluginId: string; error: string }[] } }
  constructor(private readonly packages: InstalledPackageRepository, private readonly sessions: SessionRepository,
    private readonly inputs: SessionService, private readonly permissions: PermissionService,
    private readonly tools: (sessionId: string, turnId: string) => RuntimeTool[],
    private readonly workspaceSnapshot: (sessionId: string) => unknown = () => null,
    private readonly prepareTool?: (args: { name: string; input: Record<string, unknown> }, signal: AbortSignal) => Promise<void>,
    private readonly documents?: (action: 'document.read' | 'document.save', input: unknown, context: DocumentInvocation) => Promise<unknown>) {
    this.journal = new PluginUiActionJournal(sessions.database)
    this.state = new ExtensionStateRepository(sessions.database)
  }

  list() {
    const catalog = this.staticCatalog()
    return { ...catalog, modules: catalog.modules.map(module => module.document.apiVersion === 2
      ? { ...module, configurationRevision: this.state.configurationRevision(module.pluginId, module.componentId) } : module) }
  }
  private staticCatalog() {
    const stamp = this.packages.uiCatalogStamp()
    if (this.catalog?.stamp === stamp) return this.catalog.value
    const modules: ReturnType<InstalledPackageRepository['uiModules']> = [], errors: { pluginId: string; error: string }[] = []
    for (const item of this.packages.runtimeSelections()) {
      try { modules.push(...this.packages.uiModules(item.id, item.revision)) }
      catch (error) { errors.push({ pluginId: item.id, error: error instanceof Error ? error.message : String(error) }) }
    }
    const value = { modules: modules.map(({ source: _source, resources: _resources, ...item }) => item), errors }
    this.catalog = { stamp, value }
    return value
  }
  read(input: { pluginId: string; componentId: string; revision: string }) {
    const module = this.packages.uiModules(input.pluginId, input.revision).find(item => item.componentId === input.componentId)
    if (!module) throw new Error('UI component is unavailable')
    return module
  }
  report(input: PluginUiReport) {
    const module = this.read(input)
    if (input.viewId && !module.document.views.some(view => view.id === input.viewId)) throw new Error('UI report names an undeclared view')
    const account = currentAccount()?.key ?? 'local'
    this.reports.set(JSON.stringify([account, input.clientId, input.pluginId, input.componentId, input.viewId ?? null]),
      { account, report: input, updatedAt: Date.now() })
    if (this.reports.size > 512) this.reports.delete(this.reports.keys().next().value!)
    return { recorded: true }
  }
  status() {
    const account = currentAccount()?.key ?? 'local'
    const active = new Set(this.list().modules.map(module => JSON.stringify([module.pluginId, module.componentId, module.revision])))
    return [...this.reports.values()].filter(item => item.account === account && Date.now() - item.updatedAt < 90_000)
      .filter(item => active.has(JSON.stringify([item.report.pluginId, item.report.componentId, item.report.revision])))
      .map(({ report, updatedAt }) => ({ pluginId: report.pluginId, componentId: report.componentId, client: this.diagnostics.client(report.clientId),
        viewId: report.viewId, status: report.status, error: report.error, executionState: report.executionState, updatedAt }))
  }
  reportDiagnostic(input: PluginUiDiagnostic) {
    this.scope({ ...input, action: 'session.read', input: {}, requestId: randomUUID() })
    this.diagnostics.report(currentAccount()?.key ?? 'local', input)
    return { recorded: true }
  }
  diagnosticStatus(sessionId: string, pluginId?: string) {
    this.sessions.ownership.assert(sessionId)
    return this.diagnostics.read(currentAccount()?.key ?? 'local', sessionId, pluginId)
  }
  private scope(input: PluginUiCall) {
    const module = this.read(input)
    if (!module.document.views.some(view => view.id === input.viewId)
      && !(module.document.apiVersion === 2 && input.viewId === '$extension')) throw new Error('UI view is not declared')
    if (!input.sessionId) throw new Error('Select an application conversation before using this action')
    const session = this.sessions.read(input.sessionId)
    if (session.sourceChannel !== 'app' || session.purpose !== 'user_chat' || session.status !== 'active' || session.archived)
      throw new Error('UI actions require an active application conversation owned by the current account')
    return { module, session }
  }
  call(input: PluginUiCall, lifetime?: AbortSignal): Promise<JsonValue> {
    lifetime?.throwIfAborted()
    const { session } = this.scope(input), fingerprint = JSON.stringify(input)
    const previous = this.completed.get(input.requestId)
    if (previous) {
      if (previous.sessionId !== session.id || previous.fingerprint !== fingerprint) throw new Error('UI request identity was reused')
      return Promise.resolve(previous.result)
    }
    const active = this.pending.get(input.requestId)
    if (active) {
      if (active.sessionId !== session.id || active.fingerprint !== fingerprint) throw new Error('UI request identity was reused')
      return active.promise
    }
    if (input.action === 'tool.call') this.journal.assertFresh(session.id, input.requestId)
    if (this.pending.size >= 64 || input.action === 'tool.call' && [...this.pending.values()].filter(item => item.action === 'tool.call').length >= 16)
      throw new Error('UI operation queue is full; finish or cancel a pending operation first')
    const controller = new AbortController(), diagnostic = this.diagnostics.start(currentAccount()?.key ?? 'local', input)
    const disconnected = () => controller.abort(lifetime?.reason ?? new Error('UI connection closed'))
    lifetime?.addEventListener('abort', disconnected, { once: true })
    if (lifetime?.aborted) disconnected()
    const timer = setTimeout(() => controller.abort(new Error('UI operation timed out')), 120_000)
    const promise = Promise.resolve().then(() => this.execute(input, controller.signal, diagnostic)).then(result => {
      const failed = result && typeof result === 'object' && !Array.isArray(result) && result.isError === true
      if (diagnostic?.phase !== 'finished') this.diagnostics.phase(diagnostic, 'finished', failed ? 'failed' : 'completed')
      this.completed.set(input.requestId, { sessionId: session.id, fingerprint, result })
      if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!)
      return result
    }).catch(error => {
      this.diagnostics.phase(diagnostic, 'finished', toolFailureOutcome(error, controller.signal), error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => {
      clearTimeout(timer); lifetime?.removeEventListener('abort', disconnected); this.pending.delete(input.requestId)
    })
    this.pending.set(input.requestId, { controller, sessionId: session.id, fingerprint, promise,
      action: input.action, context: operationContext(input), state: 'waiting' })
    return promise
  }
  cancel(requestId: string) {
    const pending = this.pending.get(requestId)
    if (pending) { this.sessions.read(pending.sessionId); pending.controller.abort(new Error('UI operation cancelled')) }
    return { cancelled: Boolean(pending) }
  }
  operation(input: import('@eden/api').PluginUiContext & { requestId: string }) {
    if (!input.sessionId) throw new Error('Select an application conversation before using this action')
    this.sessions.ownership.assert(input.sessionId)
    const pending = this.pending.get(input.requestId)
    if (pending) {
      if (pending.context !== operationContext(input)) throw new Error('UI operation belongs to another instance')
      return { state: pending.state }
    }
    const completed = this.completed.get(input.requestId)
    if (completed && completed.sessionId === input.sessionId) {
      if (operationContext(JSON.parse(completed.fingerprint)) !== operationContext(input)) throw new Error('UI operation belongs to another instance')
      return { state: 'completed' as const }
    }
    return { state: 'unknown' as const }
  }
  async close() {
    for (const item of this.pending.values()) item.controller.abort(new Error('UI service closed'))
    await Promise.allSettled([...this.pending.values()].map(item => item.promise))
    this.completed.clear()
    this.reports.clear()
    this.diagnostics.clear()
  }
  private async execute(input: PluginUiCall, signal: AbortSignal, diagnostic?: ReturnType<PluginUiDiagnostics['start']>): Promise<JsonValue> {
    const { module, session } = this.scope(input), grants = module.document.capabilities
    signal.throwIfAborted()
    if (input.action === 'extension.state') {
      return this.executeState(input, signal)
    }
    if (input.action === 'document.read' || input.action === 'document.save') {
      if (module.document.apiVersion !== 2 || !module.document.capabilities.documents || !this.documents)
        throw new Error('Extension does not declare document access')
      const action = input.action, account = currentAccount(), snapshot = JSON.stringify(this.workspaceSnapshot(session.id))
      return this.inputs.queueIdleAction(session.id, signal, reserved => withAccount(account, async () => {
        const pending = this.pending.get(input.requestId)
        if (pending) pending.state = 'approval'
        const assertCurrent = () => {
          reserved.throwIfAborted(); this.scope(input)
          if (JSON.stringify(this.workspaceSnapshot(session.id)) !== snapshot) throw new Error('Workspace changed while waiting for document access')
        }
        assertCurrent()
        return toJson(await this.documents!(action, input.input, { sessionId: session.id, turnId: randomUUID(), callId: input.requestId, signal: reserved, assertCurrent,
          onApproved: () => { if (pending) pending.state = 'running' } }))
      }))
    }
    if (input.action === 'session.read') {
      if (!grants.sessionRead) throw new Error('UI component does not declare sessionRead')
      z.object({}).strict().parse(input.input)
      return toJson({ id: session.id, title: session.title, executionStatus: session.executionStatus, participants: session.participants })
    }
    if (input.action === 'session.send') {
      if (!grants.sessionSend) throw new Error('UI component does not declare sessionSend')
      const { text } = z.object({ text: z.string().trim().min(1).max(100_000) }).strict().parse(input.input)
      return toJson(this.inputs.start(session.id, text, `plugin-ui:${input.requestId}`))
    }
    const args = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }).strict().parse(input.input)
    if (!grants.tools.includes(args.name)) throw new Error('Tool is not declared by this UI component')
    const account = currentAccount()
    const context = JSON.stringify([session.participants, this.workspaceSnapshot(session.id)])
    return this.inputs.queueIdleAction(session.id, signal, reserved => withAccount(account, () => {
      const current = this.scope(input).session
      if (JSON.stringify([current.participants, this.workspaceSnapshot(session.id)]) !== context)
        throw new Error('会话角色或工作区已变化，请确认后重新提交操作。')
      return this.executeTool(input, args, session.id, reserved, diagnostic)
    }))
  }
  private async executeState(input: PluginUiCall, signal: AbortSignal) {
    const { module, session } = this.scope(input), writing = input.input.value !== undefined || input.input.remove === true
    const snapshot = this.workspaceSnapshot(session.id)
    const pending = this.pending.get(input.requestId)
    if (pending) pending.state = 'approval'
    await this.permissions.request({ sessionId: session.id, turnId: randomUUID(), callId: input.requestId, signal },
      writing ? 'plugin.state.write' : 'plugin.state.read', module.pluginId, input.input)
    signal.throwIfAborted(); this.scope(input)
    if (pending) pending.state = 'running'
    if (input.input.scope === 'workspace' && JSON.stringify(snapshot) !== JSON.stringify(this.workspaceSnapshot(session.id)))
      throw new Error('Workspace changed during extension state approval')
    return toJson(this.state.access(module, input.input, snapshot))
  }
  private async executeTool(input: PluginUiCall, args: { name: string; input: Record<string, unknown> }, sessionId: string, signal: AbortSignal, diagnostic?: ReturnType<PluginUiDiagnostics['start']>) {
    const before = JSON.stringify([this.scope(input).session.participants, this.workspaceSnapshot(sessionId)])
    await this.prepareTool?.(args, signal)
    const current = this.scope(input).session
    if (JSON.stringify([current.participants, this.workspaceSnapshot(sessionId)]) !== before)
      throw new Error('会话角色或工作区已变化，请确认后重新提交操作。')
    const turnId = randomUUID(), tool = this.tools(sessionId, turnId).find(item => item.name === args.name)
    if (!tool) throw new Error('Tool is unavailable in this conversation')
    const selected = resolveRuntimeTool(tool, args.input, input.requestId)
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.scope(input)
      selected.tool.assertCurrent?.()
    }
    const pending = this.pending.get(input.requestId)
    const onPermissionState = (state: 'waiting' | 'resolved') => {
      const phase = state === 'waiting' ? 'approval' : 'running'
      if (pending) pending.state = phase
      this.diagnostics.phase(diagnostic, phase)
    }
    const context = { sessionId, turnId, callId: input.requestId, signal, assertCurrent, onPermissionState }
    if (pending) pending.state = 'approval'
    this.diagnostics.phase(diagnostic, 'approval')
    await this.permissions.request(context, 'plugin.ui.tool', `${input.pluginId}/${args.name}`, toJson(args.input))
    assertCurrent()
    if (pending) pending.state = 'running'
    this.diagnostics.phase(diagnostic, 'running')
    this.sessions.events.append(sessionId, turnId, 'plugin.ui.action.started',
      { pluginId: input.pluginId, componentId: input.componentId, requestId: input.requestId, tool: args.name })
    try {
      const result = toJson(await selected.tool.execute(selected.input, context))
      const outcome = selected.tool.outcome?.(result) ?? 'completed'
      this.diagnostics.phase(diagnostic, 'finished', outcome)
      this.sessions.events.append(sessionId, turnId, 'plugin.ui.action.finished',
        { requestId: input.requestId, outcome })
      return result
    } catch (error) {
      this.sessions.events.append(sessionId, turnId, 'plugin.ui.action.finished',
        { requestId: input.requestId, outcome: selected.tool.failureOutcome?.(error) ?? toolFailureOutcome(error, signal),
          error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}
