import { MonHttpError } from '@eden/integrations'
import { OperationFailure } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
export const maxProjectionAttempts = 8
export const projectionError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 8192)
export function permanentProjectionFailure(error: unknown) {
  return error instanceof OperationFailure && !error.details.retryable && (error.details.outcome === 'failed' || error.details.kind === 'projection_paused')
    || error instanceof MonHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
}
export function beginProjectionAttempt(database: EdenDatabase, id: string) {
  const db = database.connection
  const row = db.prepare('SELECT state,error FROM mon_projection_outbox WHERE id=?').get(id)!
  const attempts = Number(db.prepare('SELECT attempts FROM mon_projection_attempts WHERE id=?').get(id)?.attempts ?? 0)
  if (row.state === 'failed' || row.state === 'held' || attempts >= maxProjectionAttempts) {
    throw new OperationFailure(`Core 同步已暂停；请处理原因后在同步记录中恢复。${row.error ? ` ${row.error}` : ''}`,
      { kind: 'projection_paused', retryable: false, outcome: row.state === 'failed' ? 'failed' : 'unknown' })
  }
  db.prepare('INSERT INTO mon_projection_attempts VALUES(?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1').run(id)
}
export function failProjection(database: EdenDatabase, id: string, error: unknown) {
  const state = permanentProjectionFailure(error) ? 'failed' : 'unknown'
  database.connection.prepare('UPDATE mon_projection_outbox SET state=?,error=?,updated_at=? WHERE id=?')
    .run(state, projectionError(error), Date.now(), id)
}
/** Preserve legacy receipt IDs during credential-independent key migration. */
export function existingProjection(database: EdenDatabase, sessionId: string, destination: string, kind: string, payload: string, fallbackId: string) {
  return String(database.connection.prepare(`SELECT id FROM mon_projection_outbox WHERE session_id=? AND destination_key=? AND kind=? AND payload_json=?
    ORDER BY CASE WHEN state='applied' THEN 0 ELSE 1 END,created_at LIMIT 1`).get(sessionId, destination, kind, payload)?.id ?? fallbackId)
}
