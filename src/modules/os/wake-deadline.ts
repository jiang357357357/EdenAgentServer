import { existsSync } from 'node:fs'
import path from 'node:path'
import { readState } from './state-store.ts'
import { iso, time } from './contracts.ts'
import type { State } from './contracts.ts'

export function activated(state: State, at: number) {
  state.wake_anchor_at = iso(at); state.forced_wake_deadline_at = iso(at + 24 * 3600000)
}
export function enforceDeadline(state: State, now: number) {
  const anchor = time(state.wake_anchor_at) ?? time(state.last_event?.occurred_at) ?? time(state.last_run_at) ?? now
  const fallback = anchor + 12 * 3600000, deadline = anchor + 24 * 3600000
  activated(state, anchor)
  const next = time(state.next_wake_at)
  if (next !== undefined && state.next_wake_source === 'retry') return
  const explicit = next !== undefined && state.next_wake_source === 'tool', limit = explicit ? deadline : fallback
  if (!busy(state) && (next === undefined || next > limit)) Object.assign(state, { next_wake_at: iso(limit),
    next_wake_after_minutes: Math.max(0, Math.floor((limit - now) / 60000)),
    next_wake_reason: explicit ? '24 小时强制自醒截止时间' : '12 小时自醒兜底截止时间', next_wake_source: explicit ? 'tool' : 'watchdog' })
}
export function observeActivation(state: State, directory: string, now: number) {
  const filename = path.join(directory, 'agent_activation.json')
  if (!existsSync(filename)) return
  const snapshot = readState(filename)
  if (state.session_id && state.session_id !== snapshot.session_id) throw new Error('自醒执行快照属于其他会话')
  const started = time(snapshot.started_at)
  if (started === undefined || started > now) return
  if (started > (time(state.wake_anchor_at) ?? -Infinity)) {
    const preserve = preserveActivationPlan(state, started)
    activated(state, started); state.last_observed_wake_id = snapshot.run_id
    if (!preserve) Object.assign(state, { next_wake_at: iso(started + 12 * 3600000), next_wake_source: 'watchdog',
      next_wake_reason: '12 小时自醒兜底截止时间', next_wake_after_minutes: Math.max(0, Math.floor((started + 12 * 3600000 - now) / 60000)) })
  }
  const completed = time(snapshot.completed_at)
  if (completionIsNew(state, started, completed, now)) {
    state.last_observed_completed_at = iso(completed)
    if (completed! >= (time(state.last_run_at) ?? -Infinity)) { state.consecutive_agent_failures = 0; state.last_error = '' }
  }
  enforceDeadline(state, now)
}
function preserveActivationPlan(state: State, started: number): boolean {
  const next = time(state.next_wake_at), tool = state.next_wake_source === 'tool' || state.last_timer_tool_source === 'eden-agent'
  const fallback = state.next_wake_source === 'watchdog' || state.next_wake_reason === '12 小时自醒兜底截止时间'
  return next !== undefined && (state.next_wake_source === 'retry' || (tool && !fallback && next > started && next <= started + 12 * 3600000))
}
function completionIsNew(state: State, started: number, completed: number | undefined, now: number): boolean {
  return time(state.wake_anchor_at) === started && completed !== undefined && completed <= now && completed > (time(state.last_observed_completed_at) ?? -Infinity)
}
export function busy(state: State): boolean { return ['queued', 'pending', 'running'].includes(state.last_agent_async_status) }

export function retryWake(state: State, error: string, now: number, base: number, cap: number) {
  const failures = Math.max(0, Number(state.consecutive_agent_failures) || 0) + 1
  const minutes = Math.min(cap, base * 2 ** Math.min(30, failures - 1))
  Object.assign(state, { consecutive_agent_failures: failures, last_error: error, last_error_kind: null, next_wake_source: 'retry',
    next_wake_at: iso(now + minutes * 60000), next_wake_after_minutes: minutes, next_wake_reason: '失败后退避重试' })
}
