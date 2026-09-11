import { readFileSync } from 'node:fs'
import type { EdenDatabase } from '@eden/store'

export const wakeIntervalMs = 12 * 60 * 60 * 1000

/** Persist the initial anchor; setting another timer never renews the watchdog. */
export function wakeDeadline(database: EdenDatabase, stateFile?: string, now = Date.now()): number {
  if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    const anchor = state.wake_anchor_at ?? state.last_event?.occurred_at ?? state.last_run_at
    const parsed = Date.parse(anchor)
    if (Number.isFinite(parsed)) return parsed + wakeIntervalMs
  }
  const db = database.connection
  db.prepare("INSERT OR IGNORE INTO realm_meta(key,value) VALUES('self_awake_initial_anchor',?)").run(String(now))
  const initial = Number(db.prepare("SELECT value FROM realm_meta WHERE key='self_awake_initial_anchor'").get()?.value)
  const latest = Number(db.prepare('SELECT MAX(started_at) AS stamp FROM self_awake_runs').get()?.stamp ?? initial)
  return latest + wakeIntervalMs
}
