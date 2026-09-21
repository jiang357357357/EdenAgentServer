import type { JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { SessionOwnership } from '../../accounts/index.ts'

/** Latest real chat for this account and character, with at most three exchanges. */
export function recentSharedTopics(database: EdenDatabase, sessionId: string, author: JsonValue) {
  const identity = object(author), profile = object(identity.profile)
  const characterId = identity.characterId ?? object(profile.character).id
  if (typeof characterId !== 'string' && typeof characterId !== 'number') return []
  const ownership = new SessionOwnership(database)
  ownership.assert(sessionId)
  const account = ownership.owner(sessionId) ?? null
  const rows = database.connection.prepare(`WITH eligible AS (
    SELECT i.* FROM inputs i JOIN sessions s ON s.id=i.session_id
    WHERE i.kind='prompt' AND i.state IN ('completed','running','queued') AND s.status='active'
    AND (i.session_id=? OR (? IS NOT NULL AND i.session_id IN (SELECT session_id FROM session_owners WHERE account_key=?)))
    AND json_extract(i.metadata_json,'$.job') IS NULL
    AND COALESCE(json_extract(i.metadata_json,'$.internalHandoff'),0)=0
    AND COALESCE(json_extract(i.metadata_json,'$.environment.sessionPurpose'),'')!='self_awake'
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.input_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM subagent_threads t WHERE t.child_session_id=i.session_id)
    AND EXISTS(SELECT 1 FROM json_each(i.metadata_json,'$.participants') p
      WHERE CAST(COALESCE(json_extract(p.value,'$.characterId'),json_extract(p.value,'$.profile.character.id')) AS TEXT)=?)
  ) SELECT * FROM eligible WHERE session_id=(SELECT session_id FROM eligible ORDER BY created_at DESC,id DESC LIMIT 1)
    ORDER BY created_at DESC,id DESC LIMIT 3`).all(sessionId, account, account, String(characterId))
  return rows.reverse().map(row => {
    const metadata = object(JSON.parse(String(row.metadata_json)))
    const participants = Array.isArray(metadata.participants) ? metadata.participants.map(object) : []
    const actor = participants.find(p => String(p.characterId ?? object(object(p.profile).character).id) === String(characterId))
    const actorId = actor?.assistantId ?? identity.assistantId ?? characterId
    const events = database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=? AND turn_id=?
      AND kind='agent.message_end' AND json_extract(payload_json,'$.message.role')='assistant'
      AND COALESCE(json_extract(payload_json,'$.message.stopReason'),'stop')='stop'
      AND (json_extract(payload_json,'$.actor.assistantID') IS NULL OR CAST(json_extract(payload_json,'$.actor.assistantID') AS TEXT)=?)
      ORDER BY seq DESC LIMIT 1`).get(row.session_id!, row.turn_id!, String(actorId))
    const message = events ? object(object(JSON.parse(String(events.payload_json))).message) : {}
    const reply = plainText(message.content)
    const user = clip(String(row.text)), assistant = clip(reply)
    return { source: 'user_conversation', turnState: String(row.state), sessionId: String(row.session_id), turnId: String(row.turn_id),
      occurredAt: new Date(Number(row.created_at)).toISOString(), userText: user.text, assistantText: assistant.text,
      replyAvailable: Boolean(reply), truncated: user.truncated || assistant.truncated }
  })
}
function plainText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.map(object).filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n') : ''
}
function clip(text: string) { const chars = Array.from(text); return { text: chars.slice(0, 8000).join(''), truncated: chars.length > 8000 } }
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
