import { readFileSync } from 'node:fs'
import { z } from 'zod'

const stateSchema = z.object({ enabled: z.boolean(), next_wake_at: z.string().nullable().optional(),
  next_wake_reason: z.string().nullable().optional() })

/** MonOs owns this schedule; the Agent only reads the explicitly configured state file. */
export function readExternalSchedule(filename?: string) {
  if (!filename) return null
  try {
    const state = stateSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
    if (!state.enabled || !state.next_wake_at) return null
    const date = new Date(state.next_wake_at)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule timestamp')
    return { status: 'scheduled' as const, nextWakeAt: date.toISOString(), reason: state.next_wake_reason ?? 'MonOs 自醒计划' }
  } catch { throw new Error('无法读取 MonOs 自醒计划，请检查服务配置中的调度文件') }
}
