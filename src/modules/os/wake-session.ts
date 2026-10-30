import path from 'node:path'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pendingRequests, readState, saveState } from './state-store.ts'
import { activated, busy, enforceDeadline, observeActivation, retryWake } from './wake-deadline.ts'
import { time, iso } from './contracts.ts'
import type { OsConfig, State, WakeTarget } from './contracts.ts'

const requestSchema = z.object({ schema_version: z.literal('self-awake.schedule.v2'), session_id: z.uuid(), revision: z.number().int().nonnegative(),
  scope_kind: z.enum(['role', 'retired', 'session_task']).optional(), action: z.enum(['schedule', 'watchdog', 'cancel']),
  requested_at: z.string().refine(v => time(v) !== undefined), next_wake_at: z.string().nullable().optional(),
  job_id: z.uuid().nullable().optional(), legacy_request_id: z.uuid().nullish(), reason: z.string().optional() }).passthrough()

/** One role/session owns one clock, one durable admission and one retry sequence. */
export class WakeSession {
  readonly directory: string
  constructor(private readonly config: OsConfig, readonly sessionId: string, private readonly target: WakeTarget) {
    this.directory = path.join(config.wakeDir, 'sessions', sessionId)
  }
  private save(state: State) { saveState(path.join(this.directory, 'state.json'), state) }
  private requests(state: State) {
    const requests = pendingRequests(path.join(this.directory, 'schedule_requests')).map(({ filename, value }) => ({ filename, value: requestSchema.parse(value) }))
    for (const { value } of requests) validateRequest(value, this.sessionId)
    const latest = requests.toSorted((a, b) => b.value.revision - a.value.revision)[0]?.value
    if (latest && latest.revision > (state.revision ?? 0)) {
      Object.assign(state, { revision: latest.revision, enabled: latest.action !== 'cancel', scope_kind: latest.scope_kind ?? 'legacy_session',
        next_wake_at: latest.next_wake_at ?? null, next_wake_source: latest.action === 'watchdog' ? 'watchdog' : 'tool',
        next_wake_reason: latest.reason ?? '', scheduled_job_id: latest.job_id ?? null, pending_submission: null, last_error: '', last_error_kind: null })
      state.wake_anchor_at ??= latest.requested_at; this.save(state)
    }
    for (const { filename, value } of requests) {
      if (value.legacy_request_id) saveState(path.join(this.config.wakeDir, 'session_handoffs', `${value.legacy_request_id}.json`),
        { session_id: this.sessionId, request_id: value.legacy_request_id })
      rmSync(filename)
    }
  }
  async tick(now = Date.now()): Promise<void> {
    const state = readState(path.join(this.directory, 'state.json'), { session_id: this.sessionId, enabled: false, revision: 0,
      next_wake_at: null, scheduled_job_id: null, pending_submission: null, last_agent_async_status: null })
    if (state.session_id !== this.sessionId) throw new Error('自醒状态属于其他会话')
    this.requests(state)
    if (state.enabled !== true) return
    const planned = state.scheduled_job_id ? { next_wake_at: state.next_wake_at, next_wake_reason: state.next_wake_reason,
      next_wake_source: state.next_wake_source, next_wake_after_minutes: state.next_wake_after_minutes } : undefined
    observeActivation(state, this.directory, now)
    if (planned) Object.assign(state, planned)
    if (busy(state)) { await this.reconcile(state, now); this.save(state); return }
    if (state.scope_kind !== 'session_task') enforceDeadline(state, now)
    this.save(state)
    if ((time(state.next_wake_at) ?? -Infinity) > now && !this.recovered(state, now)) return
    if (!state.pending_submission) {
      const event = randomUUID()
      state.pending_submission = { schema_version: 'self-awake.v2', user_id: this.config.identity!.userId,
        session_id: this.sessionId, event_id: event, idempotency_key: `session:${this.sessionId}:${event}`,
        ...(state.scheduled_job_id ? { scheduled_job_id: state.scheduled_job_id } : {}),
        context: { type: 'scheduled', source: 'monos', reason: state.next_wake_reason, occurred_at: iso(now) } }
      state.submission_revision = state.revision; this.save(state)
    }
    await this.submit(state, now)
    this.save(state)
  }
  private async submit(state: State, now: number) {
    try {
      const result = await this.target.run(state.pending_submission)
      if (result.accepted !== true) throw new Error('Agent 未接受自醒计划')
      if (result.retired === true) Object.assign(state, { enabled: false, scope_kind: 'retired', pending_submission: null,
        scheduled_job_id: null, next_wake_at: null, last_agent_async_status: 'cancelled' })
      else Object.assign(state, { last_agent_job_id: result.job_id, last_agent_async_status: 'pending',
        last_agent_event_id: state.pending_submission.event_id, last_agent_idempotency_key: state.pending_submission.idempotency_key,
        pending_submission: null, scheduled_job_id: null, next_agent_result_poll_at: iso(now + this.config.pollSeconds * 1000), last_error: '', last_error_kind: null })
    } catch (error) { retryWake(state, error instanceof Error ? error.message : 'Agent 自醒提交失败', now, this.config.retryMinutes, this.config.retryMaxMinutes) }
  }
  private recovered(state: State, now: number): boolean {
    if (!['connect', 'timeout', 'request'].includes(state.last_error_kind)) return false
    const event = state.pending_submission?.event_id
    if (!event || state.availability_retry_event_id === event || (time(state.next_agent_availability_probe_at) ?? 0) > now) return false
    state.next_agent_availability_probe_at = iso(now + 30000)
    if (!this.target.ready()) { this.save(state); return false }
    state.availability_retry_event_id = event; state.agent_available_at = iso(now); this.save(state)
    return true
  }
  private async reconcile(state: State, now: number) {
    if ((time(state.next_agent_result_poll_at) ?? 0) > now) return
    state.next_agent_result_poll_at = iso(now + this.config.pollSeconds * 1000)
    let run: State
    try { run = await this.target.status(String(state.last_agent_job_id), this.config.identity!.userId) }
    catch (error) { state.last_error = error instanceof Error ? error.message : '自醒状态读取失败'; return }
    const started = time(run.started_at)
    if (started !== undefined && started > (time(state.wake_anchor_at) ?? 0)) activated(state, started)
    if (['queued', 'pending', 'running', 'awaiting_action', 'action_running', 'action_interrupted', 'unknown'].includes(run.status)) return
    this.finish(state, run, now)
  }
  private finish(state: State, run: State, now: number) {
    state.last_agent_async_status = run.status
    const newer = state.revision > state.submission_revision, failed = run.status === 'failed' || run.status === 'cancelled'
    if (failed && !newer) retryWake(state, run.error || '自醒任务失败', now, this.config.retryMinutes, this.config.retryMaxMinutes)
    if (!failed) {
      state.consecutive_agent_failures = 0; state.last_error = ''
      if (!newer) { state.next_wake_at = run.next_wake_at ?? null; state.next_wake_source = 'result' }
    }
    if (state.scope_kind === 'session_task') {
      if (!newer && !failed) { state.enabled = false; state.next_wake_at = null }
    } else enforceDeadline(state, now)
  }
}
function validateRequest(value: z.infer<typeof requestSchema>, sessionId: string) {
  if (value.session_id !== sessionId) throw new Error('自醒计划归属无效')
  if (value.scope_kind === 'retired' && value.action !== 'cancel') throw new Error('已退役角色不能继续自醒')
  if (value.action === 'watchdog' && value.scope_kind !== 'role') throw new Error('只有角色可设置兜底时钟')
  if (value.action === 'schedule' && (!value.job_id || time(value.next_wake_at) === undefined)) throw new Error('自醒任务和时间无效')
}
