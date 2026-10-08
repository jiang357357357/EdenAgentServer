import type { ReplyTimerSnapshot, ReplyTimerTurn } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { readReplyTimerBreakdown } from './reply-timer-breakdown.ts'

/** Read only indexed turn boundaries, including a running turn with no assistant messages yet. */
export function readReplyTimer(database: EdenDatabase, sessionId: string): ReplyTimerSnapshot {
  const startQuery = database.connection.prepare(`SELECT turn_id,seq,created_at FROM events INDEXED BY events_session_kind_seq
    WHERE session_id=? AND kind='turn.started' ORDER BY seq DESC LIMIT 1`)
  startQuery.setReadBigInts(true)
  const start = startQuery.get(sessionId)
  let turn: ReplyTimerTurn | null = null
  if (start?.turn_id) {
    const startedAt = Number(start.created_at)
    if (Number.isSafeInteger(startedAt) && startedAt >= 0) {
      const endQuery = database.connection.prepare(`SELECT seq,created_at FROM events INDEXED BY events_session_turn_kind_seq
        WHERE session_id=? AND turn_id=? AND kind=? AND seq>? ORDER BY seq LIMIT 1`)
      endQuery.setReadBigInts(true)
      const endings = [
        ['turn.completed', 'completed'], ['input.interrupted', 'interrupted'], ['turn.failed', 'failed'],
      ] as const
      let endSeq: bigint | undefined
      turn = { turnId: String(start.turn_id), startedAt, outcome: 'running' }
      for (const [kind, outcome] of endings) {
        const end: Record<string, unknown> | undefined = endQuery.get(sessionId, String(start.turn_id), kind, start.seq!)
        if (!end || (endSeq !== undefined && (end.seq as bigint) >= endSeq)) continue
        endSeq = end.seq as bigint
        const finishedAt = Number(end.created_at)
        turn = { ...turn, finishedAt, outcome }
      }
      if (turn.finishedAt !== undefined && (!Number.isSafeInteger(turn.finishedAt) || turn.finishedAt < startedAt)) turn = null
    }
  }
  const cursorQuery = database.connection.prepare('SELECT seq FROM events WHERE session_id=? ORDER BY seq DESC LIMIT 1')
  cursorQuery.setReadBigInts(true)
  const seq = String(cursorQuery.get(sessionId)?.seq ?? 0), observedAt = Date.now()
  return { turn, seq, observedAt, breakdown: readReplyTimerBreakdown(database, sessionId, turn, observedAt) }
}
