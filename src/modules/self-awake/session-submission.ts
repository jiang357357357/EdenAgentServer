import { createHash } from 'node:crypto'
import { z } from 'zod'
import { jsonValue, toJson } from '@eden/api'
import type { MonServiceIdentity } from '@eden/integrations'
import { accountKey, withAccount } from '../accounts/index.ts'
import type { SessionService } from '../sessions/index.ts'
import type { SelfAwakeBridgeRepository } from './bridge-repository.ts'
import { SelfAwakeRoleRepository } from './role-repository.ts'

export const sessionWakeSubmission = z.object({ schema_version: z.literal('self-awake.v2'),
  user_id: z.union([z.string().min(1).max(128), z.number().int()]).transform(String), session_id: z.uuid(),
  scheduled_job_id: z.uuid().optional(), event_id: z.string().min(1).max(256),
  idempotency_key: z.string().min(1).max(256), context: jsonValue }).strict()

/** Each scope admits independently; service authentication never grants another account's session. */
export class SessionWakeSubmissions {
  private readonly pending = new Map<string, Promise<unknown>>()
  private closed = false
  constructor(private readonly identity: MonServiceIdentity, private readonly repository: SelfAwakeBridgeRepository,
    private readonly sessions: SessionService) {}

  submit(input: z.output<typeof sessionWakeSubmission>) {
    if (this.closed) return Promise.reject(new Error('Self-awake bridge is closing'))
    const task = (this.pending.get(input.session_id) ?? Promise.resolve()).catch(() => {}).then(() => withAccount({
      key: accountKey(this.identity.coreBaseUrl, input.user_id), userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl,
    }, () => this.admit(input)))
    this.pending.set(input.session_id, task)
    void task.finally(() => { if (this.pending.get(input.session_id) === task) this.pending.delete(input.session_id) }).catch(() => {})
    return task
  }

  private admit(input: z.output<typeof sessionWakeSubmission>) {
    if (this.closed) throw new Error('Self-awake bridge is closing')
    if (input.user_id !== this.identity.userId) throw new Error('Self-awake user mismatch')
    const session = this.sessions.repository.read(input.session_id)
    if (session.status !== 'active') throw new Error('Self-awake session is closed')
    if (session.participants.length !== 1) throw new Error('Session self-awake requires one explicitly selected participant')
    const roles = new SelfAwakeRoleRepository(this.sessions.repository.database)
    if (roles.target(input.session_id) !== input.session_id) return toJson({ accepted: true, retired: true, status: 'cancelled', session_id: input.session_id })
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    let job = this.repository.existing(input.user_id, input.idempotency_key, hash)
    if (job && job.sessionId !== input.session_id) throw new Error('Self-awake request belongs to another session')
    if (!job && input.scheduled_job_id) job = this.repository.activate(input.user_id, input.idempotency_key, hash, input.session_id, input.scheduled_job_id)
    if (!job) job = this.repository.coalesce(input.user_id, input.idempotency_key, hash, input.session_id)
    if (!job) job = this.repository.submit(input.user_id, input.idempotency_key, hash, {
      kind: 'self_awake', sessionId: input.session_id, dueAt: Date.now(),
      payload: { schemaVersion: 'self-awake.v2', scheduler: 'monos', ...roles.payload(input.session_id), userId: input.user_id,
        eventId: input.event_id, trigger: input.context, prompt: '' },
      key: `self-awake:${input.user_id}:${input.session_id}:${input.idempotency_key}`, causationId: input.event_id, depth: 0,
    })
    return toJson({ accepted: true, async_run_id: job.id, job_id: job.id, session_id: input.session_id,
      event_id: input.event_id, idempotency_key: input.idempotency_key, status: job.state })
  }

  async close() { this.closed = true; await Promise.allSettled(this.pending.values()) }
}
