import { resultFields as fields, resultList, resultObject, type ModelResult } from './model-fields.ts'
import type { JsonValue } from '@eden/api'

export const emailResult: ModelResult = (value, _input, hidden) => fields(value,
  ['channel', 'status', 'alreadyAccepted', 'note', 'confirmed'], hidden, ['requestId', 'request_id'])

export const deviceListResult: ModelResult = value => resultList(value, item => fields(item,
  ['id', 'name', 'model', 'device_type', 'firmware_version', 'protocol_version', 'capabilities', 'status', 'last_seen']))

export const deviceCommandResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const row = fields(raw, ['id', 'device_id', 'domain', 'action', 'status', 'error_code', 'error_message',
    'expires_at', 'created_at', 'completed_at'], hidden, ['request_id', 'requestId'])
  if (raw.arguments) row.arguments = fields(raw.arguments, ['text', 'title', 'duration_ms', 'reason', 'current_situation', 'suggested_opening'])
  if (Object.hasOwn(raw, 'call')) row.call = raw.call === null ? null : fields(raw.call!,
    ['status', 'expires_at', 'answered_at', 'ended_at', 'ended_reason'])
  // Device-defined business output is opaque; the Core command envelope is projected above.
  if (Object.hasOwn(raw, 'result')) row.result = raw.result!
  return row
}

export const assistantListResult: ModelResult = value => {
  const raw = resultObject(value)
  return { assistants: resultList(raw.assistants!, assistantSummary) }
}

function assistantSummary(assistant: JsonValue) {
  const row = fields(assistant, ['id', 'name', 'description', 'signature', 'enabled', 'is_current', 'isDefault'])
  const character = resultObject(assistant).character
  if (character && typeof character === 'object') row.character = fields(character, ['id', 'name', 'description', 'signature'])
  return row
}

export const handoffResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const row = fields(raw, ['historyPreserved', 'effectiveFrom', 'status'], hidden, ['jobId'])
  if (raw.assistant) row.assistant = assistantSummary(raw.assistant)
  if (raw.participant) row.participant = fields(raw.participant, ['assistantId', 'assistantName', 'characterId', 'characterName'])
  return row
}
