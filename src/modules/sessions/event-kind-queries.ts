import type { EdenDatabase } from '@eden/store'

/** Each seek fixes the index's kind prefix; unrelated stream rows and payloads are never scanned. */
export function projectionSequences(database: EdenDatabase, sessionId: string, after: bigint, through: bigint,
  kinds: readonly string[], limit: number): bigint[] {
  const statement = database.connection.prepare(`SELECT seq FROM events INDEXED BY events_session_kind_seq
    WHERE session_id=? AND kind=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
  statement.setReadBigInts(true)
  const candidates: bigint[] = []
  for (const kind of new Set(kinds)) {
    for (const row of statement.all(sessionId, kind, after, through, limit)) candidates.push(row.seq as bigint)
  }
  return candidates.sort((left, right) => left < right ? -1 : left > right ? 1 : 0).slice(0, limit)
}

export function latestKindRecord(database: EdenDatabase, sessionId: string, kinds: readonly string[]): { seq: bigint; createdAt: number } | undefined {
  const statement = database.connection.prepare(`SELECT seq,created_at FROM events INDEXED BY events_session_kind_seq
    WHERE session_id=? AND kind=? ORDER BY seq DESC LIMIT 1`)
  statement.setReadBigInts(true)
  let latest: { seq: bigint; createdAt: number } | undefined
  for (const kind of new Set(kinds)) {
    const row = statement.get(sessionId, kind)
    if (row && (!latest || (row.seq as bigint) > latest.seq)) latest = { seq: row.seq as bigint, createdAt: Number(row.created_at) }
  }
  return latest
}
