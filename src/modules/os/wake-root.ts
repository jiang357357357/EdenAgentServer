import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pendingRequests, readState, saveState } from './state-store.ts'
import { rmSync } from 'node:fs'
import { busy, enforceDeadline, observeActivation, retryWake, activated } from './wake-deadline.ts'
import { iso, time, uuidPattern } from './contracts.ts'
import type { State, OsConfig, WakeTarget } from './contracts.ts'

/** Bootstrap the account's role; once handed off, the role scheduler is its only clock. */
export class WakeRoot {
  constructor(private readonly config: OsConfig, private readonly target: WakeTarget) {}
  private save(state: State) { saveState(path.join(this.config.wakeDir, 'state.json'), state) }
  async tick(startup = false, now = Date.now()): Promise<void> {
    const state = readState(path.join(this.config.wakeDir, 'state.json'), { enabled: true, next_wake_at: null, last_run_at: null, last_decision: null })
    const delegated = this.delegated(state)
    if (delegated && !startup) return
    this.handoff(state, now)
    observeActivation(state, this.config.wakeDir, now)
    this.requests(state)
    if (busy(state)) { await this.reconcile(state, now); this.save(state); return }
    enforceDeadline(state, now); this.save(state)
    if (!startup && (state.enabled === false || (time(state.next_wake_at) ?? -Infinity) > now)) return
    if (!state.pending_submission) {
      const event = randomUUID(), kind = startup ? 'startup' : 'scheduled'
      state.pending_submission = { schema_version: 'self-awake.v1', user_id: this.config.identity!.userId,
        event_id: event, idempotency_key: `selfawake:${event}`, context: { type: kind, source: 'monos',
          reason: startup ? '重启检查' : 'scheduled', wake_reason: startup ? '重启检查' : state.next_wake_reason, occurred_at: iso(now), current_time: iso(now) } }
      this.save(state)
    }
    await this.submit(state, now)
    this.save(state)
  }
  private async submit(state: State, now: number) {
    try {
      const response = await this.target.run(state.pending_submission)
      if (response.accepted !== true) throw new Error('Agent 未接受后台自醒')
      if (response.role_session_id) {
        if (!uuidPattern.test(response.role_session_id)) throw new Error('角色调度归属无效')
        state.delegated_role_session_id = response.role_session_id
      }
      Object.assign(state, { last_agent_job_id: response.job_id, last_agent_async_run_id: response.async_run_id,
        last_agent_async_status: 'pending', last_agent_event_id: state.pending_submission.event_id,
        last_agent_idempotency_key: state.pending_submission.idempotency_key, last_event: state.pending_submission.context,
        pending_submission: null, last_run_at: iso(now), next_agent_result_poll_at: iso(now + this.config.pollSeconds * 1000), last_error: '' })
    } catch (error) { retryWake(state, error instanceof Error ? error.message : '后台自醒失败', now, this.config.retryMinutes, this.config.retryMaxMinutes) }
  }
  private delegated(state: State): boolean {
    const manifest = readState(path.join(this.config.wakeDir, 'role-coordinator.json'))
    if (Object.keys(manifest).length && (manifest.schema_version !== 'self-awake.roles.v1' || manifest.user_id !== this.config.identity!.userId))
      throw new Error('后台角色调度账号不匹配；原账号计划已保留')
    const ids = Array.isArray(manifest.session_ids) && manifest.session_ids.length ? manifest.session_ids : state.delegated_role_session_id ? [state.delegated_role_session_id] : []
    return ids.length > 0 && ids.every((id: unknown) => {
      if (typeof id !== 'string' || !uuidPattern.test(id)) throw new Error('后台角色调度标识无效')
      const filename = path.join(this.config.wakeDir, 'sessions', id, 'state.json')
      if (!existsSync(filename)) return false
      const role = readState(filename)
      if (role.session_id !== id) throw new Error('后台角色调度归属不匹配')
      return role.scope_kind === 'role'
    })
  }
  private handoff(state: State, now: number) {
    const id = state.last_schedule_request_id
    if (state.next_wake_source !== 'tool' || typeof id !== 'string' || !uuidPattern.test(id)) return
    const filename = path.join(this.config.wakeDir, 'session_handoffs', `${id}.json`)
    if (!existsSync(filename)) return
    if (readState(filename).request_id !== id) throw new Error('自醒计划迁移标记无效')
    Object.assign(state, { next_wake_at: null, next_wake_source: 'watchdog', last_schedule_request_id: null }); enforceDeadline(state, now)
  }
  private requests(state: State) {
    const requests = pendingRequests(path.join(this.config.wakeDir, 'schedule_requests'))
    const latest = requests.toSorted((a, b) => String(b.value.requested_at).localeCompare(String(a.value.requested_at)))[0]?.value
    if (latest && time(latest.next_wake_at) !== undefined) {
      Object.assign(state, { enabled: true, next_wake_source: 'tool', next_wake_at: latest.next_wake_at,
        next_wake_after_minutes: latest.after_minutes ?? null, next_wake_reason: latest.reason || 'Agent 请求调整自醒时间。',
        last_timer_tool_at: latest.requested_at ?? iso(), last_timer_tool_source: latest.requested_by || 'monagent', last_schedule_request_id: latest.request_id ?? '' })
      this.save(state)
    }
    for (const request of requests) rmSync(request.filename)
  }
  private async reconcile(state: State, now: number) {
    if ((time(state.next_agent_result_poll_at) ?? 0) > now) return
    state.next_agent_result_poll_at = iso(now + this.config.pollSeconds * 1000)
    let run: State
    try { run = await this.target.status(String(state.last_agent_job_id || state.last_agent_async_run_id), this.config.identity!.userId) }
    catch (error) { state.last_status_error = error instanceof Error ? error.message : '后台状态读取失败'; return }
    const started = time(run.started_at)
    if (started !== undefined && started > (time(state.wake_anchor_at) ?? 0)) activated(state, started)
    if (['queued', 'pending', 'running', 'awaiting_action', 'action_running', 'action_interrupted', 'unknown'].includes(run.status)) return
    this.finish(state, run, now)
  }
  private finish(state: State, run: State, now: number) {
    state.last_agent_async_status = run.status; state.last_decision = run.decision_payload ?? null
    if (run.status === 'failed' || run.status === 'cancelled') { retryWake(state, run.error || '后台自醒失败', now, this.config.retryMinutes, this.config.retryMaxMinutes); return }
    state.consecutive_agent_failures = 0; state.last_error = ''; state.last_run_at = run.finished_at ?? run.updated_at ?? iso(now)
    const preserve = state.next_wake_source === 'tool' && (time(state.last_timer_tool_at) ?? 0) > (time(state.last_event?.occurred_at) ?? Infinity)
    if (!preserve) {
      const minutes = Math.max(1, Math.min(1440, Number(run.decision_payload?.next_wake?.after_minutes) || 720))
      Object.assign(state, { next_wake_at: run.next_wake_at ?? iso(now + minutes * 60000), next_wake_source: 'result',
        next_wake_after_minutes: minutes, next_wake_reason: run.decision_payload?.next_wake?.reason ?? 'Agent 自醒结果已回收。' })
    }
    enforceDeadline(state, now)
  }
}
