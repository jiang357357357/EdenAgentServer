import { SessionOwnership, withAccount } from '../accounts/index.ts'
import type { SessionService } from '../sessions/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { SelfAwakeRoleRepository } from './role-repository.ts'
import { wakeRoleIdentity } from './role-identity.ts'

/** A dedicated execution context is reused for a role; ordinary chat timers cannot grow new owners. */
export class SelfAwakeRoleSessions {
  private readonly pending = new Map<string, Promise<string>>()
  private closed = false
  readonly roles: SelfAwakeRoleRepository
  constructor(private readonly sessions: SessionService, private readonly mon: MonBindingService) {
    this.roles = new SelfAwakeRoleRepository(sessions.repository.database)
  }

  async timerTarget(sourceId: string, turnId?: string, actorId?: string | number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const identity = wakeRoleIdentity(this.sessions.repository, sourceId, turnId, actorId)
    if (!identity) return sourceId // Unbound local contexts have no global role identity.
    const work = async () => {
      if (this.closed) throw new Error('角色自醒调度正在关闭')
      const existing = this.roles.find(identity)
      if (existing) return existing
      const source = this.sessions.repository.read(sourceId)
      if (source.purpose === 'self_awake') return this.roles.register(this.sessions.repository, sourceId)
      const environment = source.environment && typeof source.environment === 'object' && !Array.isArray(source.environment) ? source.environment : {}
      const owner = new SessionOwnership(this.sessions.repository.database).account(sourceId)
      const create = () => this.sessions.repository.create('角色后台自醒', [identity.author],
        { timezone: environment.timezone ?? 'Asia/Shanghai', locale: environment.locale ?? 'zh-CN', sessionPurpose: 'self_awake', ...(owner ? { selfAwakeUserId: owner.userId } : {}) },
        { purpose: 'self_awake', sourceChannel: 'internal' })
      const target = owner ? withAccount(owner, create) : create()
      try {
        if (this.sessions.repository.origin === 'mon') await this.mon.backgroundCatalog(sourceId, target.id)
        signal?.throwIfAborted()
        if (this.closed) throw new Error('角色自醒调度正在关闭')
        const canonical = this.roles.register(this.sessions.repository, target.id)
        if (canonical !== target.id) await this.sessions.endSession(target.id, 'closed')
        return canonical
      } catch (error) { await this.sessions.endSession(target.id, 'closed'); throw error }
    }
    const previous = this.pending.get(identity.key) ?? Promise.resolve('')
    const next = previous.catch(() => '').then(work)
    this.pending.set(identity.key, next)
    try { return await next }
    finally { if (this.pending.get(identity.key) === next) this.pending.delete(identity.key) }
  }

  async close(): Promise<void> { this.closed = true; await Promise.allSettled(this.pending.values()) }
}
