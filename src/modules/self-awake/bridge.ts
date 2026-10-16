import { accountKey, withAccount } from '../accounts/index.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import { jsonValue, toJson } from '@eden/api'
import type { SessionService } from '../sessions/index.ts'
import { assistantParticipant } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { SelfAwakeBridgeRepository } from './bridge-repository.ts'
import { SelfAwakeStageError, selfAwakeStage, selfAwakeStageAsync } from './diagnostic.ts'
import { SessionWakeSubmissions, sessionWakeSubmission } from './session-submission.ts'
import { SelfAwakeRoleRepository } from './role-repository.ts'
import { wakeRoleFromAuthor } from './role-identity.ts'

const userId = z.union([z.string().min(1).max(128), z.number().int()]).transform(String)
const submission = z.object({ user_id: userId, schema_version: z.literal('self-awake.v1'), idempotency_key: z.string().min(1).max(256),
  event_id: z.string().min(1).max(256), context: jsonValue }).strict()
const status = z.object({ user_id: userId, job_id: z.uuid() }).strict()

export class SelfAwakeBridge {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()
  private readonly scoped: SessionWakeSubmissions
  constructor(readonly identity: MonServiceIdentity, readonly repository: SelfAwakeBridgeRepository,
    private readonly sessions: SessionService, private readonly mon: MonBindingService) {
    this.scoped = new SessionWakeSubmissions(identity, repository, sessions)
  }
  async close(): Promise<void> { this.abort.abort(); await Promise.all([this.tail.catch(() => {}), this.scoped.close()]) }
  readStatus(raw: unknown) {
    const input = selfAwakeStage('status_validation', () => status.parse(raw))
    selfAwakeStage('owner_identity', () => { if (input.user_id !== this.identity.userId) throw new Error('Self-awake user mismatch') })
    return selfAwakeStage('status_lookup', () => toJson(this.repository.status(input.user_id, input.job_id)))
  }
  submit(raw: unknown) {
    if (raw && typeof raw === 'object' && 'schema_version' in raw && raw.schema_version === 'self-awake.v2')
      return this.scoped.submit(selfAwakeStage('submission_validation', () => sessionWakeSubmission.parse(raw)))
    const input = selfAwakeStage('submission_validation', () => submission.parse(raw))
    selfAwakeStage('owner_identity', () => { if (input.user_id !== this.identity.userId) throw new Error('Self-awake user mismatch') })
    const task = this.tail.then(async () => {
      selfAwakeStage('service_availability', () => this.abort.signal.throwIfAborted())
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      let job = selfAwakeStage('idempotency', () => this.repository.existing(input.user_id, input.idempotency_key, hash))
      if (!job) {
        const token = await selfAwakeStageAsync('service_token', () => acquireMonServiceToken(this.identity, this.abort.signal))
        const client = new MonClient(this.identity.coreBaseUrl, token)
        const detail = await selfAwakeStageAsync('assistant_fetch', () => client.get('/api/assistants/current/', this.abort.signal))
        const author = selfAwakeStage('assistant_profile', () => assistantParticipant(detail))
        const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id), userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
        const roles = new SelfAwakeRoleRepository(this.sessions.repository.database)
        const role = selfAwakeStage('assistant_profile', () => wakeRoleFromAuthor('mon', account.key, author))
        const target = role ? withAccount(account, () => roles.find(role)) : undefined
        if (target) job = withAccount(account, () => this.repository.coalesce(input.user_id, input.idempotency_key, hash, target)
          ?? this.repository.recent(input.user_id, input.idempotency_key, hash, target))
        if (job) return this.response(input, job)
        const session = selfAwakeStage('session_create', () => withAccount(account, () => target ? this.sessions.repository.read(target)
          : this.sessions.repository.create('角色后台自醒', [author],
            { sessionPurpose: 'self_awake', selfAwakeUserId: input.user_id, timezone: 'Asia/Shanghai', locale: 'zh-CN' },
            { purpose: 'self_awake', sourceChannel: 'internal' })))
        try {
          if (!target) await selfAwakeStageAsync('model_catalog', () => this.mon.catalog({ sessionId: session.id, coreBaseUrl: this.identity.coreBaseUrl, coreToken: token, serviceCredential: true }))
          selfAwakeStage('service_availability', () => this.abort.signal.throwIfAborted())
          const canonical = withAccount(account, () => roles.register(this.sessions.repository, session.id))
          if (canonical !== session.id) {
            if (!target) await this.sessions.endSession(session.id, 'closed')
            job = this.repository.coalesce(input.user_id, input.idempotency_key, hash, canonical)
          }
          job ??= selfAwakeStage('job_persist', () => this.repository.submit(input.user_id, input.idempotency_key, hash, { kind: 'self_awake', sessionId: canonical, dueAt: Date.now(),
            payload: { schemaVersion: 'self-awake.v1', scheduler: 'monos', ...roles.payload(canonical), eventId: input.event_id, userId: input.user_id, trigger: input.context, prompt: '' },
            key: `self-awake:${input.user_id}:${input.idempotency_key}`, causationId: input.event_id, depth: 0 }))
        } catch (error) {
          // Keep the failed preparation auditable without leaving an active empty background session.
          const failure = error instanceof SelfAwakeStageError ? error : new SelfAwakeStageError('submission_processing', error)
          try { if (!target) await this.sessions.endSession(session.id, 'closed') }
          catch { failure.cleanupFailed = true }
          throw failure
        }
      }
      return this.response(input, job)
    })
    this.tail = task.catch(() => {})
    return task
  }
  private response(input: z.output<typeof submission>, job: import('@eden/api').JobInfo) {
    const payload = job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload) ? job.payload : {}
    return selfAwakeStage('response_serialization', () => toJson({ accepted: true, async_run_id: job.id, job_id: job.id,
      ...(payload.roleScope ? { role_session_id: job.sessionId } : {}),
      event_id: input.event_id, idempotency_key: input.idempotency_key, status: job.state }))
  }
}
