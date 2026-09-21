import { modelParticipant } from '@eden/api'
import type { JsonValue, JobInfo } from '@eden/api'
import { selfAwakeInstruction } from '../../model-prompts/self-awake.ts'

export function selfAwakeRequest(job: JobInfo, author: JsonValue, environment: JsonValue) {
  const payload = job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload) ? job.payload : {}
  const rawTrigger = payload.trigger && typeof payload.trigger === 'object' && !Array.isArray(payload.trigger) ? payload.trigger : { type: 'scheduled', reason: payload.prompt ?? 'periodic observation' }
  const allowed = ['type', 'source', 'reason', 'wake_reason', 'occurred_at', 'current_time', 'title', 'details']
  const trigger = Object.fromEntries(allowed.filter(key => typeof rawTrigger[key] === 'string').map(key => [key, String(rawTrigger[key]).slice(0, 4000)]))
  return { schema_version: 'self-awake.v1', job_id: job.id, event_id: String(payload.eventId ?? ''),
    idempotency_key: job.key, trigger,
    author: modelParticipant(author), environment, memories: [], recent_diaries: [], conversation_history: [] }
}

export function selfAwakePromptContext(request: JsonValue) {
  const value = object(request) ?? {}
  const trigger = object(value.trigger) ?? {}
  const { reason, wake_reason, ...activation } = trigger
  const schedule = object(value.wakeSchedule)
  const scheduled = trigger.type === 'scheduled'
  return { current_time: value.current_time ?? null, trigger: scheduled ? activation : trigger,
    environment: value.environment ?? null, recent_conversation: value.recent_conversation ?? [], wakeSchedule: schedule ? { status: schedule.status ?? null, nextWakeAt: schedule.nextWakeAt ?? null, source: schedule.source ?? 'unknown' } : null }
}

export function selfAwakePrompt(request: JsonValue): string {
  return selfAwakeInstruction(selfAwakePromptContext(request))
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
