import type { SessionRepository } from '../sessions/index.ts'
import type { MonConnectionRepository } from './connection-repository.ts'
import { destinationDigest, migrateDestination, monDestination } from './destination.ts'
import type { DurableEvent } from '@eden/api'

/** Core session/message projections upsert external IDs. Other external operations are never replayed here. */
export function resumeProjection(sessions: SessionRepository, connections: MonConnectionRepository, sessionId: string) {
  sessions.read(sessionId)
  const connection = connections.readForSync(sessionId)
  if (!connection) throw new Error('请先为当前会话绑定 Core')
  migrateDestination(sessions.database, sessionId, connection)
  const key = destinationDigest(monDestination(connection)), db = sessions.database.connection
  let event: DurableEvent | undefined
  const result = sessions.database.transaction(() => {
    const paused = db.prepare('SELECT error,attempts FROM mon_sync_progress WHERE session_id=? AND destination_key=? AND retry_at=-1').get(sessionId, key)
    if (!paused) return { resumed: false }
    event = sessions.events.insert(sessionId, null, 'mon.sync.resumed', { attempts: Number(paused.attempts), previousError: paused.error === null ? null : String(paused.error) })
    db.prepare(`DELETE FROM mon_projection_attempts WHERE id IN (SELECT id FROM mon_projection_outbox
      WHERE session_id=? AND destination_key=? AND state!='applied')`).run(sessionId, key)
    db.prepare("UPDATE mon_projection_outbox SET state='pending' WHERE session_id=? AND destination_key=? AND state IN ('failed','held','unknown')").run(sessionId, key)
    db.prepare('UPDATE mon_sync_progress SET attempts=0,retry_at=0 WHERE session_id=? AND destination_key=?').run(sessionId, key)
    return { resumed: true }
  })
  if (event) sessions.events.publish(event)
  return result
}
