import { PermissionModeStore } from './permission-mode.ts'
import { randomUUID } from 'node:crypto'
import type { PermissionMode, JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { PermissionContext, PermissionRequest, PermissionEventSink } from './contracts.ts'
import { PermissionRepository } from './permission-repository.ts'

interface Waiter { resolve(): void; reject(error: Error): void }

export class PermissionService {
  private readonly pending = new Map<string, Waiter>()
  private readonly qqTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly qqQueues = new Map<string, Promise<void>>()
  private readonly modeStore: PermissionModeStore
  private readonly repository: PermissionRepository
  constructor(private readonly database: EdenDatabase, events: PermissionEventSink,
    private readonly interactiveApprovalAvailable: (sessionId: string) => boolean = () => true) {
    this.modeStore = new PermissionModeStore(database)
    this.modeStore.read()
    this.repository = new PermissionRepository(database, events)
    for (const request of this.list().filter(item => item.state === 'pending')) {
      this.repository.events.publish(this.repository.finish(request, 'interrupted'))
    }
  }

  async request(context: PermissionContext, capability: string, resource: string, details: JsonValue): Promise<void> {
    await this.requestWithId(context, capability, resource, details)
  }

  async requestWithId(context: PermissionContext, capability: string, resource: string, details: JsonValue): Promise<string> {
    context.signal.throwIfAborted()
    context.assertCurrent?.()
    const channel = this.database.connection.prepare('SELECT source_channel FROM session_classification WHERE session_id=?')
      .get(context.sessionId)?.source_channel
    if (channel !== 'qq') return this.requestWithIdNow(context, capability, resource, details, false)
    const release = await this.waitForQqApprovalSlot(context.sessionId, context.signal)
    try {
      context.signal.throwIfAborted()
      context.assertCurrent?.()
      return await this.requestWithIdNow(context, capability, resource, details, true)
    } finally {
      release()
    }
  }

  private async waitForQqApprovalSlot(sessionId: string, signal: AbortSignal): Promise<() => void> {
    const previous = this.qqQueues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const slot = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => slot)
    this.qqQueues.set(sessionId, tail)
    const abort = () => {
      release()
      if (this.qqQueues.get(sessionId) === tail) this.qqQueues.delete(sessionId)
    }
    let onAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('QQ approval cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      if (signal.aborted) onAbort()
      await Promise.race([previous, cancelled])
      signal.throwIfAborted()
    } catch (error) {
      abort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    return abort
  }

  private async requestWithIdNow(context: PermissionContext, capability: string, resource: string,
    details: JsonValue, qqChannel: boolean): Promise<string> {
    const request: PermissionRequest = { id: randomUUID(), sessionId: context.sessionId, turnId: context.turnId,
      operationId: `${context.turnId}:${context.callId}`, capability, resource, details, state: 'pending', createdAt: Date.now() }
    // QQ uses its own per-conversation mode; app grants do not cross channels.
    if (qqChannel ? this.modeStore.allowsQq(context.sessionId, capability)
      : this.modeStore.allows(capability) || this.repository.granted(request)) request.state = 'allowed'
    const event = this.repository.insert(request)
    if (request.state === 'allowed') { this.repository.events.publish(event); context.assertCurrent?.(); return request.id }
    if (!this.interactiveApprovalAvailable(context.sessionId)) {
      this.repository.events.publish(event)
      const message = '后台运行无法等待交互审批；已有持久授权或允许该能力后可在下次运行中执行'
      this.resolve(request.id, false, 'denied', false, message)
      throw Object.assign(new Error(`Permission unavailable in background run: ${capability}`), { toolOutcome: 'failed' })
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        try { this.resolve(request.id, false, 'cancelled') }
        catch (error) { this.pending.delete(request.id); cleanup(); reject(error) }
      }
      const cleanup = () => context.signal.removeEventListener('abort', abort)
      this.pending.set(request.id, {
        resolve: () => { cleanup(); resolve() }, reject: error => { cleanup(); reject(error) },
      })
      if (qqChannel) {
        const timer = setTimeout(() => {
          try { this.resolve(request.id, false, 'denied', false, 'QQ 审批等待超时') } catch { /* already resolved */ }
        }, 150_000)
        this.qqTimers.set(request.id, timer)
      }
      context.signal.addEventListener('abort', abort, { once: true })
      this.repository.events.publish(event)
      if (context.signal.aborted && this.pending.has(request.id)) abort()
    })
    context.assertCurrent?.()
    return request.id
  }

  mode(): PermissionMode { return this.modeStore.read() }

  setMode(mode: PermissionMode): PermissionMode { return this.modeStore.set(mode) }

  qqMode(botQq: string, contactQq: string): PermissionMode { return this.modeStore.qqMode(botQq, contactQq) }

  setQqMode(botQq: string, contactQq: string, mode: PermissionMode): PermissionMode {
    return this.modeStore.setQqMode(botQq, contactQq, mode)
  }

  list(sessionId?: string): PermissionRequest[] { return this.repository.list(sessionId) }

  resolve(id: string, allowed: boolean, deniedState = 'denied', persistGrant = false, message: string | null = null): void {
    const request = this.find(id)
    if (request.state !== 'pending') throw new Error('Permission request already resolved')
    if (persistGrant && !allowed) throw new Error('Only an allowed request can create a grant')
    const event = this.repository.finish(request, allowed ? 'allowed' : deniedState, persistGrant, message)
    const timer = this.qqTimers.get(id)
    if (timer) clearTimeout(timer)
    this.qqTimers.delete(id)
    const waiter = this.pending.get(id)
    this.pending.delete(id)
    if (allowed) waiter?.resolve()
    else waiter?.reject(Object.assign(new Error(`Permission ${deniedState}: ${request.capability}`), { toolOutcome: deniedState === 'cancelled' ? 'cancelled' : 'failed' }))
    this.repository.events.publish(event)
  }

  revoke(id: string): void { this.repository.revoke(this.find(id)) }

  private find(id: string): PermissionRequest {
    const request = this.list().find(item => item.id === id)
    if (!request) throw new Error('Permission request not found')
    return request
  }
}
