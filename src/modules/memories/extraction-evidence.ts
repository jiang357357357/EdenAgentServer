import type { EdenDatabase } from '@eden/store'

export interface ExtractionActionEvidence {
  tool: 'set_self_awake_timer' | 'write_diary'
  effect: 'plan_saved_and_published' | 'diary_saved'
  confirmed: true
  scheduledAt?: string
}

/** Only committed receipts for this actor ground execution facts; raw arguments and IDs stay private. */
export function extractionActionEvidence(database: EdenDatabase, source: { sessionId: string; turnId: string; actorId: string }): ExtractionActionEvidence[] {
  const input = database.connection.prepare('SELECT metadata_json FROM inputs WHERE session_id=? AND turn_id=?')
    .get(source.sessionId, source.turnId)
  const metadata = object(JSON.parse(String(input?.metadata_json ?? '{}')))
  const multi = Array.isArray(metadata.participants) && metadata.participants.length > 1
  const rows = database.connection.prepare(`SELECT o.tool_name,o.result_json FROM tool_operations o
    WHERE o.session_id=? AND o.turn_id=? AND o.state='completed'
    AND o.tool_name IN ('set_self_awake_timer','write_diary')
    AND (?=0 OR EXISTS(SELECT 1 FROM events e WHERE e.session_id=o.session_id AND e.turn_id=o.turn_id
      AND e.kind='operation.started' AND o.id=o.turn_id||':'||json_extract(e.payload_json,'$.callId')
      AND CAST(json_extract(e.payload_json,'$.actor.assistantID') AS TEXT)=?)) ORDER BY o.created_at`)
    .all(source.sessionId, source.turnId, Number(multi), source.actorId)
  const evidence: ExtractionActionEvidence[] = []
  for (const row of rows) {
    const result = object(JSON.parse(String(row.result_json ?? '{}')))
    if (row.tool_name === 'write_diary' && result.status === 'saved')
      evidence.push({ tool: 'write_diary', effect: 'diary_saved', confirmed: true })
    if (row.tool_name === 'set_self_awake_timer' && result.delivery === 'persisted_and_published'
      && typeof result.scheduledAt === 'string' && Number.isFinite(Date.parse(result.scheduledAt)))
      evidence.push({ tool: 'set_self_awake_timer', effect: 'plan_saved_and_published', confirmed: true, scheduledAt: result.scheduledAt })
  }
  return evidence
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
