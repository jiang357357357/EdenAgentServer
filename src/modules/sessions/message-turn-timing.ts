import type { DurableEvent, JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'

interface TurnTiming { startedAt: number; completedAt?: number }

function assistantPayload(event: DurableEvent): Record<string, JsonValue> | undefined {
  const payload = event.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const message = payload.message
  return message && typeof message === 'object' && !Array.isArray(message) && message.role === 'assistant' ? payload : undefined
}

/** Add a read projection; persisted messages and their original timestamps stay unchanged. */
export function withMessageTurnTiming(database: EdenDatabase, sessionId: string, events: DurableEvent[]): DurableEvent[] {
  const turnIds = new Set(events.filter(event => assistantPayload(event)).flatMap(event => event.turnId ? [event.turnId] : []))
  if (!turnIds.size) return events
  // At most two exact index seeks per turn represented on this bounded message page.
  // Loading a final reply never requires replaying its tool calls or the full history.
  const boundary = database.connection.prepare(`SELECT seq,created_at FROM events INDEXED BY events_session_turn_kind_seq
    WHERE session_id=? AND turn_id=? AND kind=? ORDER BY seq LIMIT 1`)
  boundary.setReadBigInts(true)
  const timings = new Map<string, TurnTiming>()
  for (const turnId of turnIds) {
    const start = boundary.get(sessionId, turnId, 'turn.started')
    if (!start) continue
    const startedAt = Number(start.created_at)
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) continue
    const end = boundary.get(sessionId, turnId, 'turn.completed')
    const completedAt = end ? Number(end.created_at) : undefined
    const completed = end && (end.seq as bigint) > (start.seq as bigint) && completedAt !== undefined
      && Number.isSafeInteger(completedAt) && completedAt >= startedAt
    timings.set(turnId, { startedAt, ...(completed ? { completedAt } : {}) })
  }
  return events.map(event => {
    const payload = assistantPayload(event), timing = event.turnId ? timings.get(event.turnId) : undefined
    return payload && timing ? { ...event, payload: { ...payload, turnTiming: { ...timing } } } : event
  })
}
