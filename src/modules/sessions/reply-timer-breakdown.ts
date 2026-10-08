import type { ReplyTimerBreakdown, ReplyTimerTurn } from '@eden/api'
import type { EdenDatabase } from '@eden/store'

type Phase = ReplyTimerBreakdown['thinking']
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

function withinTurn(time: number, turn: ReplyTimerTurn): boolean {
  return validTime(time) && time >= turn.startedAt && (turn.finishedAt === undefined || time <= turn.finishedAt)
}

/** Read semantic boundaries only; never restore stream bodies, contexts or tool results. */
function phase(database: EdenDatabase, sessionId: string, turn: ReplyTimerTurn | null,
  startKind: string, endKind: string, idField: 'requestId' | 'callId'): Phase {
  const result: Phase = { elapsedMs: 0, activeIds: [] }
  if (!turn) return result
  const query = database.connection.prepare(`SELECT seq,created_at,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.${idField}') END AS id
    FROM events INDEXED BY events_session_turn_kind_seq
    WHERE session_id=? AND turn_id=? AND kind=? ORDER BY seq`)
  query.setReadBigInts(true)
  const rows = [startKind, endKind].flatMap(kind => query.all(sessionId, turn.turnId, kind).map(row => ({
    seq: row.seq as bigint, time: Number(row.created_at), id: row.id, start: kind === startKind,
  }))).sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)
  const active = new Set<string>()
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || !withinTurn(row.time, turn)) continue
    if (row.start) {
      if (!active.size) result.activeSince = row.time
      active.add(row.id)
    } else if (active.delete(row.id) && !active.size && result.activeSince !== undefined) {
      result.elapsedMs += Math.max(0, row.time - result.activeSince)
      delete result.activeSince
    }
  }
  if (turn.finishedAt !== undefined && result.activeSince !== undefined) {
    result.elapsedMs += Math.max(0, turn.finishedAt - result.activeSince)
    delete result.activeSince
    active.clear()
  }
  result.activeIds = [...active]
  return result
}

export function readReplyTimerBreakdown(database: EdenDatabase, sessionId: string,
  turn: ReplyTimerTurn | null, observedAt: number): ReplyTimerBreakdown {
  return { thinking: phase(database, sessionId, turn, 'model.request', 'model.response', 'requestId'),
    tools: phase(database, sessionId, turn, 'operation.started', 'operation.completed', 'callId'),
    turnElapsedMs: turn ? Math.max(0, (turn.finishedAt ?? observedAt) - turn.startedAt) : 0 }
}
