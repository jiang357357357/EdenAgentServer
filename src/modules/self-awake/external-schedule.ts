import { readFileSync } from 'node:fs'
import { z } from 'zod'

const stateSchema = z.object({ enabled: z.boolean(), next_wake_at: z.string().nullable().optional(),
  next_wake_reason: z.string().nullable().optional(), last_error: z.string().nullable().optional(),
  consecutive_agent_failures: z.number().int().nonnegative().optional() })

/** MonOs owns this schedule; the Agent only reads the explicitly configured state file. */
export function readExternalSchedule(filename?: string) {
  if (!filename) return null
  try {
    const state = stateSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
    if (!state.enabled) return { status: 'disabled' as const, nextWakeAt: null, reason: 'MonOs 自醒已暂停' }
    if (!state.next_wake_at) return { status: 'unscheduled' as const, nextWakeAt: null, reason: 'MonOs 尚未安排自醒' }
    const date = new Date(state.next_wake_at)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule timestamp')
    if (state.last_error && state.consecutive_agent_failures) return { status: 'retrying' as const, nextWakeAt: date.toISOString(),
      reason: `上次唤醒失败，累计连续失败 ${state.consecutive_agent_failures} 次；${state.next_wake_reason ?? '等待重试'}。${state.last_error}` }
    return { status: 'scheduled' as const, nextWakeAt: date.toISOString(), reason: state.next_wake_reason ?? 'MonOs 自醒计划' }
  } catch { throw new Error('无法读取 MonOs 自醒计划，请检查服务配置中的调度文件') }
}
