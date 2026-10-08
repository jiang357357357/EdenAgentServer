import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { EdenDatabase } from '@eden/store'

/** MonOs owns state.json; the Agent publishes only persisted execution facts. */
export function publishWakeActivation(database: EdenDatabase, stateFile: string, sessionId?: string): void {
  const filename = path.join(path.dirname(stateFile), 'agent_activation.json')
  const latest = sessionId
    ? database.connection.prepare(`SELECT run_id,started_at FROM self_awake_activations
      WHERE session_id=? ORDER BY started_at DESC,run_id DESC LIMIT 1`).get(sessionId)
    : database.connection.prepare(`SELECT run_id,started_at FROM self_awake_activations
      WHERE legacy_scope=1 ORDER BY started_at DESC,run_id DESC LIMIT 1`).get()
  if (!latest) { rmSync(filename, { force: true }); return }
  const row = database.connection.prepare('SELECT id,state,completed_at FROM self_awake_runs WHERE id=?').get(latest.run_id!)
  if (!row) return
  const content = JSON.stringify({ ...(sessionId ? { session_id: sessionId } : {}), run_id: row.id, started_at: new Date(Number(latest.started_at)).toISOString(),
    completed_at: row.state === 'completed' && row.completed_at != null ? new Date(Number(row.completed_at)).toISOString() : null })
  try { if (readFileSync(filename, 'utf8') === content) return }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.tmp`
  try { writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, filename) }
  finally { rmSync(temporary, { force: true }) }
}
