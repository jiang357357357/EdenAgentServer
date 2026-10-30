import type { JsonValue } from '@eden/api'
import { resultFields as fields, resultList, resultObject, type ModelResult } from './model-fields.ts'
import { modelEnvironmentContext } from '../../model-prompts/environment.ts'

export const memoryResult: ModelResult = (value, _input, hidden) => Array.isArray(value)
  ? value.map(item => memoryResult(item, undefined, hidden))
  : fields(value, ['id', 'content', 'kind', 'createdAt', 'updatedAt', 'credentialHidden', 'deleted'], hidden, ['sourceSessionId'])

export const memoResult: ModelResult = (value, _input, hidden) => {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(item => memoResult(item, undefined, hidden))
  const row = resultObject(value)
  if (Object.hasOwn(row, 'memo')) return { ...fields(row, ['nextWakeAt']), memo: memoResult(row.memo!, undefined, hidden) }
  return fields(row, ['id', 'title', 'content', 'kind', 'status', 'priority', 'remindAt', 'dueAt', 'snoozedUntil',
    'repeatRule', 'lastTriggeredAt', 'completedAt', 'createdAt', 'updatedAt'], hidden, ['relatedSessionId'])
}

export const attachmentResult: ModelResult = (value, _input, hidden) => {
  const row = resultObject(value)
  if (Object.hasOwn(row, 'attachments')) return { attachments: resultList(row.attachments!, item =>
    fields(item, ['blobId', 'mime', 'filename', 'byteLength', 'kind'], hidden, ['sha256'])) }
  return fields(row, ['blobId', 'encoding', 'offsetUnit', 'content', 'nextOffset'])
}

export const reminderResult: ModelResult = (value, _input, hidden) => {
  const row = fields(value, ['id', 'title', 'message', 'state', 'createdAt', 'displayedAt', 'closedAt'], hidden, ['sessionId', 'turnId'])
  const author = resultObject(value).author
  if (author && typeof author === 'object' && !Array.isArray(author))
    row.author = fields(author, ['assistantId', 'assistantID', 'assistantName', 'characterId', 'characterName', 'name'])
  return row
}

export const timerResult: ModelResult = (value, _input, hidden) => {
  const row = fields(value, ['id', 'kind', 'state', 'requestedAt', 'scheduledAt', 'scheduledLocal', 'timezone',
    'adjusted', 'adjustment', 'delivery', 'dueAt', 'reason'], hidden, ['key', 'causationId', 'sessionId', 'inputId'])
  const adjustment = row.adjustment
  if (adjustment && typeof adjustment === 'object') row.adjustment = fields(adjustment, ['reason', 'latestWakeAt'])
  const payload = resultObject(value).payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.prompt === 'string') row.reason = payload.prompt
  return row
}

export const diaryResult: ModelResult = value => fields(value, ['status', 'diaryId', 'title', 'savedAt'])

function topic(value: JsonValue, hidden?: Set<string>): JsonValue {
  return fields(value, ['source', 'turnState', 'occurredAt', 'userText', 'assistantText', 'replyAvailable', 'truncated'],
    hidden, ['sessionId', 'turnId'])
}

export const conversationResult: ModelResult = (value, _input, hidden) => {
  if (Array.isArray(value)) return value.map(item => topic(item, hidden))
  const row = fields(value, ['available', 'source', 'reason', 'truncated', 'hasMore', 'nextOffset', 'interpretation'])
  const raw = resultObject(value)
  for (const key of ['messages', 'recent_conversation', 'conversation', 'rounds']) if (Array.isArray(raw[key]))
    row[key] = raw[key].map(item => topic(item, hidden))
  return row
}

/** Context has already been selected by account/actor; project only host-owned containers. */
export const selfAwakeResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const row = fields(raw, ['current_time', 'trigger', 'environment', 'wakeSchedule', 'inheritedWakeNotes', 'section',
    'source', 'scope', 'count', 'totalCount', 'hasMore', 'contentMode', 'contentReason', 'emptyReason', 'interpretation',
    'coverage', 'truncated', 'scheduledCount', 'unavailableCount', 'schedules', 'available', 'fresh', 'error',
    'captured_at', 'received_at', 'ageMs', 'stale', 'data'], hidden, ['job_id', 'event_id', 'idempotency_key', 'sessionId', 'turnId'])
  if (Object.hasOwn(raw, 'run')) row.run = raw.run === null ? null : fields(raw.run!, ['status'], hidden, ['id', 'jobId', 'sessionId', 'eventId'])
  if (Array.isArray(raw.recent_conversation)) row.recent_conversation = raw.recent_conversation.map(item => topic(item, hidden))
  if (Array.isArray(raw.diaries)) row.diaries = raw.diaries.map(item => fields(item,
    ['id', 'assistantId', 'characterId', 'title', 'content', 'contentAvailable', 'createdAt', 'updatedAt'], hidden, ['sessionId', 'runId']))
  if (raw.trigger) row.trigger = fields(raw.trigger, ['type', 'source', 'reason', 'wake_reason', 'occurred_at', 'current_time', 'title', 'details'],
    hidden, ['requestId', 'request_id', 'eventId', 'jobId', 'sessionId', 'turnId'])
  if (raw.scope) row.scope = fields(raw.scope, ['kind', 'characterId', 'coverage'], hidden, ['accountKey', 'sessionId'])
  if (Object.hasOwn(raw, 'environment')) row.environment = modelEnvironmentContext(raw.environment)
  return row
}
