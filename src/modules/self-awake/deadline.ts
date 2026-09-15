import { readFileSync } from 'node:fs'
import type { EdenDatabase } from '@eden/store'

export const wakeIntervalMs = 12 * 60 * 60 * 1000

/** Persist the initial anchor; setting another timer never renews the watchdog. */
export function wakeDeadline(database: EdenDatabase, stateFile?: string, now = Date.now()): number {
  const latest = database.connection.prepare(`SELECT MAX(started_at) AS stamp FROM (
    SELECT MIN(e.created_at) AS started_at FROM self_awake_runs r JOIN events e
    ON e.session_id=r.session_id AND e.turn_id=r.turn_id WHERE e.kind='agent.agent_start' GROUP BY r.id)`).get()?.stamp
  if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    const anchor = state.wake_anchor_at ?? state.last_event?.occurred_at ?? state.last_run_at
    const parsed = Date.parse(anchor)
    if (Number.isFinite(parsed)) return Math.max(parsed, Number(latest ?? parsed)) + wakeIntervalMs
  }
  const db = database.connection
  db.prepare("INSERT OR IGNORE INTO realm_meta(key,value) VALUES('self_awake_initial_anchor',?)").run(String(now))
  const initial = Number(db.prepare("SELECT value FROM realm_meta WHERE key='self_awake_initial_anchor'").get()?.value)
  return Number(latest ?? initial) + wakeIntervalMs
}
