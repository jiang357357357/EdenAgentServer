import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { selfAwakeScopeState } from './scope-paths.ts'

const stateSchema = z.object({ enabled: z.boolean(), session_id: z.string().optional(), next_wake_at: z.string().nullable().optional(),
  revision: z.number().int().nonnegative().optional(),
  next_wake_reason: z.string().nullable().optional(), next_wake_source: z.string().nullable().optional(), last_error: z.string().nullable().optional(),
  consecutive_agent_failures: z.number().int().nonnegative().optional() })

/** MonOs owns this schedule; the Agent only reads the explicitly configured state file. */
export function readExternalSchedule(filename?: string, sessionId?: string, expectedRevision = 0) {
  if (!filename) return null
  if (sessionId) filename = selfAwakeScopeState(filename, sessionId)
  if (sessionId && !existsSync(filename)) return { status: 'unscheduled' as const, nextWakeAt: null, reason: '调度器尚未接收本会话的自醒计划' }
  try {
    const state = stateSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
    if (sessionId && state.session_id !== sessionId) throw new Error('Self-awake schedule belongs to another session')
    if (sessionId && (state.revision ?? 0) < expectedRevision) return { status: 'pending' as const, nextWakeAt: null, reason: '正在等待调度器接收最新的自醒设置' }
    if (!state.enabled) return { status: 'disabled' as const, nextWakeAt: null, reason: '自醒已暂停' }
    if (!state.next_wake_at) return { status: 'unscheduled' as const, nextWakeAt: null, reason: '调度器尚未安排自醒' }
    const date = new Date(state.next_wake_at)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule timestamp')
    return scheduledState(state, date)
  } catch { throw new Error('无法读取当前账号的自醒计划，请检查 Agent 调度状态及状态目录') }
}

function scheduledState(state: z.output<typeof stateSchema>, date: Date) {
  if (state.last_error && state.consecutive_agent_failures) return { status: 'retrying' as const, nextWakeAt: date.toISOString(),
    reason: `上次唤醒失败，累计连续失败 ${state.consecutive_agent_failures} 次；${state.next_wake_reason ?? '等待重试'}。${state.last_error}` }
  return { status: 'scheduled' as const, nextWakeAt: date.toISOString(), source: state.next_wake_source ?? 'unknown', reason: state.next_wake_reason ?? '角色自醒计划' }
}
