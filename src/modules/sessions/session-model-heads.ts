import type { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'

/** Read only durable head pointers and their exact event rows, never aggregate request history. */
export class SessionModelHeads {
  constructor(private readonly database: EdenDatabase) {}

  requests(sessionId: string) {
    this.assertRequestPayloads(sessionId)
    const heads = this.database.connection.prepare(`SELECT seq FROM session_model_request_heads
      WHERE session_id=? AND malformed=0 ORDER BY seq DESC LIMIT 32`)
    heads.setReadBigInts(true)
    const event = this.database.connection.prepare('SELECT * FROM events WHERE session_id=? AND seq=?')
    event.setReadBigInts(true)
    return heads.all(sessionId).map(head => {
      const row = event.get(sessionId, head.seq as bigint)
      if (!row) throw new Error('Persisted model request head references a missing event')
      return row
    })
  }

  actorContextEstimate(sessionId: string, actorId?: string | number): JsonValue | undefined {
    this.assertRequestPayloads(sessionId)
    const row = this.database.connection.prepare(`SELECT e.payload_json -> '$.contextEstimate' AS context_json
      FROM session_model_request_heads AS h CROSS JOIN events AS e
      WHERE h.session_id=? AND h.actor_key=? AND h.malformed=0
        AND e.session_id=h.session_id AND e.seq=h.seq`).get(sessionId, String(actorId ?? ''))
    return row?.context_json == null ? undefined : JSON.parse(String(row.context_json)) as JsonValue
  }

  usagePayload(sessionId: string): JsonValue | undefined {
    const row = this.database.connection.prepare(`SELECT e.payload_json FROM session_model_usage_heads AS h
      CROSS JOIN events AS e WHERE h.session_id=? AND e.session_id=h.session_id AND e.seq=h.seq`).get(sessionId)
    return row ? JSON.parse(String(row.payload_json)) as JsonValue : undefined
  }

  private assertRequestPayloads(sessionId: string): void {
    const invalid = this.database.connection.prepare(`SELECT 1 FROM session_model_request_heads
      WHERE session_id=? AND actor_key='' AND malformed=1`).get(sessionId)
    if (invalid) throw new Error('Malformed persisted model request JSON; repair the session history before reading context')
  }
}
