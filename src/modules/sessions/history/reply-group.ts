import type { EdenDatabase } from '@eden/store'
import { chatMessageNotDeletedSql } from './message-visibility.ts'
import { publicMessage } from './public-message.ts'

interface ReplyMember { messageId: string; turnId: string | null; role: string; speaker: string | null }
function speakerKey(speaker: string | null, actor: unknown): string | null {
  const value = speaker ? JSON.parse(speaker) as Record<string, unknown> : {}
  const assistant = value.assistantID ?? actor
  if (typeof assistant === 'string' || typeof assistant === 'number') return `assistant:${assistant}`
  const character = value.characterID
  if (typeof character === 'string' || typeof character === 'number') return `character:${character}`
  const name = value.assistantName || value.characterName
  return typeof name === 'string' && name ? `name:${name}` : null
}
function compatible(left: ReplyMember, right: ReplyMember) {
  if (left.role !== 'assistant' || right.role !== 'assistant') return false
  if (left.turnId && right.turnId && left.turnId !== right.turnId) return false
  return !left.speaker || !right.speaker || left.speaker === right.speaker
}

/** Resolve the complete visible reply independently of client pagination; hidden tool receipts do not split it. */
export function replyGroup(database: EdenDatabase, sessionId: string, messageId: string): ReplyMember[] {
  const rows = database.connection.prepare(`SELECT
    COALESCE(json_extract(candidate.payload_json,'$.messageId'),json_extract(candidate.payload_json,'$.messageID'),candidate.id) AS messageId,
    candidate.turn_id AS turnId, CASE WHEN candidate.kind='character.sticker.sent' THEN 'assistant' WHEN candidate.kind='agent.message_end'
      THEN json_extract(candidate.payload_json,'$.message.role') ELSE 'barrier' END AS role,
    COALESCE(json_extract(candidate.payload_json,'$.message.speaker'),json_extract(candidate.payload_json,'$.speaker')) AS speaker,
    json_extract(candidate.payload_json,'$.actor.assistantID') AS actor
    FROM events candidate WHERE candidate.session_id=? AND (
      (candidate.kind='agent.message_end' AND json_extract(candidate.payload_json,'$.message.role') IN ('user','assistant')
        AND COALESCE(json_extract(candidate.payload_json,'$.message.display'),1) != 0
        AND COALESCE(json_extract(candidate.payload_json,'$.message.internalHandoff'),0) != 1)
      OR candidate.kind='character.sticker.sent'
      OR (candidate.kind='agent.session_compact' AND json_type(candidate.payload_json,'$.compactionEntry.summary')='text')
      OR (candidate.kind='input.queued' AND json_extract(candidate.payload_json,'$.kind')='compact'))
    AND ${chatMessageNotDeletedSql} ORDER BY candidate.seq`).all(sessionId)
  const members = rows.map(row => ({ messageId: String(row.messageId), turnId: row.turnId === null ? null : String(row.turnId),
    role: String(row.role), speaker: speakerKey(row.speaker === null ? null : String(row.speaker), row.actor) }))
  const index = members.findIndex(row => row.messageId === messageId && row.role === 'assistant')
  if (index < 0) throw new Error('这组回答不存在或尚未完成。')
  let first = index, last = index
  while (first > 0 && compatible(members[first - 1]!, members[first]!)) first--
  while (last + 1 < members.length && compatible(members[last]!, members[last + 1]!)) last++
  return members.slice(first, last + 1)
}

export function replyText(database: EdenDatabase, sessionId: string, messageIds: string[]): string {
  const rows = database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=? AND kind='agent.message_end'
    AND COALESCE(json_extract(payload_json,'$.messageId'),json_extract(payload_json,'$.messageID'),id)
      IN (SELECT value FROM json_each(?)) ORDER BY seq`).all(sessionId, JSON.stringify(messageIds))
  return rows.flatMap(row => {
    const message = publicMessage(JSON.parse(String(row.payload_json))) as { text?: string } | null
    return message?.text?.trim() ? [message.text] : []
  }).join('\n\n')
}
