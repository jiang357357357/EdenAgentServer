import { createHash } from 'node:crypto'
import type { EdenDatabase } from '@eden/store'
interface MonConnection { coreBaseUrl: string; coreToken: string }
export const destinationDigest = (value: string) => createHash('sha256').update(value).digest('hex')
/** Each database belongs to one verified account. The credential is not a remote identity. */
export function monDestination(connection: MonConnection): string {
  return JSON.stringify({ coreBaseUrl: new URL(connection.coreBaseUrl.replace(/\/+$/, '') + '/').href })
}
export function migrateDestination(database: EdenDatabase, sessionId: string, connection: MonConnection) {
  const oldKey = destinationDigest(JSON.stringify(connection)), key = destinationDigest(monDestination(connection))
  const db = database.connection
  const old = db.prepare('SELECT after_seq,attempts,retry_at,error FROM mon_sync_progress WHERE session_id=? AND destination_key=?').get(sessionId, oldKey)
  if (!old && !db.prepare('SELECT 1 FROM mon_projection_outbox WHERE session_id=? AND destination_key=? LIMIT 1').get(sessionId, oldKey)) return
  const migrate = () => {
    const current = db.prepare('SELECT after_seq FROM mon_sync_progress WHERE session_id=? AND destination_key=?').get(sessionId, key)
    // Only the currently bound, exact legacy credential is migrated; unrelated destinations remain auditable.
    if (old && (!current || BigInt(String(old.after_seq)) > BigInt(String(current.after_seq)))) {
      db.prepare(`INSERT INTO mon_sync_progress VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,destination_key)
        DO UPDATE SET after_seq=excluded.after_seq,attempts=excluded.attempts,retry_at=excluded.retry_at,error=excluded.error`)
        .run(sessionId, key, String(old.after_seq), Number(old.attempts), Number(old.retry_at), old.error ?? null)
    }
    if (old) db.prepare('DELETE FROM mon_sync_progress WHERE session_id=? AND destination_key=?').run(sessionId, oldKey)
    db.prepare('UPDATE mon_projection_outbox SET destination_key=? WHERE session_id=? AND destination_key=?').run(key, sessionId, oldKey)
  }
  if (database.inTransaction) migrate(); else database.transaction(migrate)
}
