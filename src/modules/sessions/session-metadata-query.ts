import type { EdenDatabase } from '@eden/store'

type MetadataKind = 'session.created' | 'session.metadata.updated' | 'session.title_updated' | 'session.renamed'
interface MetadataEvent { kind: MetadataKind; seq: bigint; payloadJson: string; createdAt: number }

/** Each exact kind is one index endpoint; merging these few heads avoids scanning stream history. */
export function latestMetadataEvent(database: EdenDatabase, sessionId: string, kinds: readonly MetadataKind[]): MetadataEvent | undefined {
  const statement = database.connection.prepare(`SELECT seq,payload_json,created_at FROM events
    WHERE session_id=? AND kind=? ORDER BY seq DESC LIMIT 1`)
  statement.setReadBigInts(true)
  let latest: MetadataEvent | undefined
  for (const kind of kinds) {
    const row = statement.get(sessionId, kind)
    if (!row) continue
    const seq = row.seq as bigint
    if (!latest || seq > latest.seq) latest = { kind, seq, payloadJson: String(row.payload_json), createdAt: Number(row.created_at) }
  }
  return latest
}
