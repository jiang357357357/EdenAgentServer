import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { EdenDatabase } from '@eden/store'

/** MonOs owns state.json; the Agent publishes only persisted execution facts. */
export function publishWakeActivation(database: EdenDatabase, stateFile: string): void {
  const row = database.connection.prepare(`SELECT r.id, MIN(e.created_at) AS started_at,
    r.state,r.completed_at FROM self_awake_runs r JOIN events e ON e.session_id=r.session_id AND e.turn_id=r.turn_id
    WHERE e.kind='agent.agent_start' GROUP BY r.id ORDER BY started_at DESC LIMIT 1`).get()
  if (!row) return
  const content = JSON.stringify({ run_id: row.id, started_at: new Date(Number(row.started_at)).toISOString(),
    completed_at: row.state === 'completed' && row.completed_at != null ? new Date(Number(row.completed_at)).toISOString() : null })
  const filename = path.join(path.dirname(stateFile), 'agent_activation.json')
  try { if (readFileSync(filename, 'utf8') === content) return }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.tmp`
  try { writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, filename) }
  finally { rmSync(temporary, { force: true }) }
}
