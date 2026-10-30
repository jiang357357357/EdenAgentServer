import type { EdenDatabase } from '@eden/store'
import type { SQLOutputValue } from 'node:sqlite'
import { accountFilter } from '../accounts/index.ts'

interface WakeSchedule { status: string; nextWakeAt: string | null; reason: string; source?: string }
type ExecutionRow = Record<string, SQLOutputValue>
type ExecutionState = 'blocked' | 'failed' | 'running' | 'queued'

/** Admitted execution takes precedence; an unclaimed job must not hide scheduler backoff. */
export function executionSchedule(database: EdenDatabase, sessionId: string | undefined, plan: WakeSchedule | null, now = Date.now()): WakeSchedule | null {
  if (plan?.status === 'disabled') return plan
  const row = database.connection.prepare(`SELECT j.state AS job_state,j.due_at,j.error,r.state AS run_state,r.last_error,
    i.state AS input_state FROM jobs j LEFT JOIN self_awake_runs r ON r.job_id=j.id LEFT JOIN inputs i ON i.id=j.input_id
    WHERE j.kind='self_awake' AND ${accountFilter(database, 'j.session_id')} AND (? IS NULL OR j.session_id=?)
    ORDER BY CASE WHEN j.state IN ('running','dispatched','unknown')
      OR r.state IN ('running','awaiting_action','action_running','action_interrupted') THEN 0
      WHEN j.state='queued' THEN 1 ELSE 2 END,j.created_at DESC,j.id DESC LIMIT 1`).get(sessionId ?? null, sessionId ?? null)
  if (!row) return overdueSchedule(plan, now)
  const state = executionState(row, now)
  if (plan && ['pending', 'unavailable'].includes(plan.status) && !admittedExecution(row, state)) return plan
  if (schedulerOwnsWaiting(row, state, plan, now)) return plan
  if (!state) return overdueSchedule(plan, now)
  return { status: state, nextWakeAt: state === 'queued' ? new Date(Number(row.due_at)).toISOString() : plan?.nextWakeAt ?? null,
    reason: executionReason(state, row) }
}

function schedulerOwnsWaiting(row: ExecutionRow, state: ExecutionState | undefined, plan: WakeSchedule | null, now: number): boolean {
  if (!plan || admittedExecution(row, state)) return false
  if (plan.status === 'retrying') return true
  return state === 'queued' && plan.status === 'scheduled' && plan.nextWakeAt !== null && Date.parse(plan.nextWakeAt) > now
}

function admittedExecution(row: ExecutionRow, state: ExecutionState | undefined): boolean {
  return row.input_state === 'queued' || state === 'running' || state === 'blocked'
}

function executionState(row: ExecutionRow, now: number): ExecutionState | undefined {
  const job = String(row.job_state), run = String(row.run_state ?? '')
  if (job === 'unknown' || run === 'action_interrupted') return 'blocked'
  if (job === 'failed' || ['failed', 'action_failed'].includes(run) || ['failed', 'interrupted', 'cancelled'].includes(String(row.input_state)))
    return 'failed'
  if (['running', 'dispatched'].includes(job) || ['running', 'awaiting_action', 'action_running'].includes(run))
    return row.input_state === 'queued' ? 'queued' : 'running'
  if (job === 'queued' && Number(row.due_at) <= now) return 'queued'
  return undefined
}

function executionReason(state: ExecutionState, row: ExecutionRow): string {
  if (state === 'blocked') return '上次自醒的执行结果尚未确认，需要核对后继续；不会自动重放副作用'
  if (state === 'failed') return `最近一次自醒未能完成：${String(row.last_error ?? row.error ?? '请查看执行记录').slice(0, 2000)}`
  if (state === 'running') return '自醒已提交，正在处理本轮执行结果'
  return row.input_state === 'queued' ? '自醒已提交，正在等待会话处理' : '待执行的自醒计划已到期，等待调度派发'
}

function overdueSchedule(plan: WakeSchedule | null, now: number): WakeSchedule | null {
  if (plan?.status !== 'scheduled' || !plan.nextWakeAt || Date.parse(plan.nextWakeAt) > now - 60_000) return plan
  return { ...plan, status: 'overdue', reason: `计划已逾期超过一分钟，尚未发现正在等待或执行的自醒任务。${plan.reason}` }
}
