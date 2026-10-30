import type { JsonValue } from '@eden/api'
import { hideFields, resultFields, resultObject } from './model-fields.ts'

/** Only the archived host's documented context envelopes are interpreted here. */
export function legacyModelEnvelope(value: Record<string, JsonValue>, hidden: Set<string>): Record<string, JsonValue> {
  if (typeof value.sourceEventId !== 'string') return { ...value }
  hideFields(value, ['sourceEventId'], hidden)
  const row = resultFields(value, ['kind', 'createdAt', 'payload', 'summary'])
  if (value.kind === 'compaction') throw new Error('旧迁移摘要缺少可重建的原始上下文，需复核后重新建立模型上下文')
  if (!value.payload) return row
  const payload = resultObject(value.payload)
  if (value.kind === 'context.skill_snapshot') {
    hideFields(payload, ['snapshotID', 'snapshotId'], hidden)
    const projected = resultFields(payload, ['assistantId', 'content'])
    if (typeof projected.content === 'string')
      projected.content = projected.content.replace(/^<active_skill_snapshot id=(?:"[^"]*"|'[^']*')>/, '<active_skill_snapshot>')
    row.payload = projected
  } else if (value.kind === 'context.subagent_notification') {
    hideFields(payload, ['messageID', 'coordinationBatchId'], hidden)
    row.payload = resultFields(payload, ['senderPath', 'content'])
  } else if (payload.message) {
    row.payload = { message: payload.message }
    const actor = payload.actor
    if (actor && typeof actor === 'object') resultObject(row.payload).actor = resultFields(actor, ['assistantID'])
  }
  return row
}

/** Imported transcripts are prose, so SDK call pairing belongs to the host rather than that prose. */
export function legacyMessageBody(value: JsonValue, hidden: Set<string>) {
  const message = resultObject(value)
  hideFields(message, ['toolCallId', 'sessionId', 'turnId', 'requestId'], hidden)
  const row = resultFields(message, ['role', 'content', 'timestamp', 'toolName', 'isError', 'speaker'])
  if (Array.isArray(row.content)) row.content = row.content.map(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'toolCall') return block
    hideFields(block, ['id'], hidden)
    return resultFields(block, ['type', 'name', 'arguments'])
  })
  return row
}
