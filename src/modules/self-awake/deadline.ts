import { existsSync, readFileSync } from 'node:fs'
import type { EdenDatabase } from '@eden/store'
import { selfAwakeScopeState } from './scope-paths.ts'

export const maxWakeIntervalMs = 24 * 60 * 60 * 1000

/** An explicit timer may extend beyond the twelve-hour no-timer fallback, but never past one day. */
export function wakeDeadline(database: EdenDatabase, stateFile?: string, now = Date.now(), sessionId?: string): number {
  const db = database.connection
  const latest = latestActivation(database, sessionId)
  const filename = stateFile && sessionId ? selfAwakeScopeState(stateFile, sessionId) : stateFile
  const external = externalAnchor(filename, sessionId)
  if (external !== undefined) return Math.max(external, Number(latest ?? external)) + maxWakeIntervalMs
  if (sessionId) {
    db.prepare('INSERT OR IGNORE INTO self_awake_session_schedules(session_id,job_id,revision,published_revision,initial_anchor) VALUES(?,NULL,0,0,?)').run(sessionId, now)
    const initial = Number(db.prepare('SELECT initial_anchor FROM self_awake_session_schedules WHERE session_id=?').get(sessionId)?.initial_anchor)
    return Number(latest ?? initial) + maxWakeIntervalMs
  }
  db.prepare("INSERT OR IGNORE INTO realm_meta(key,value) VALUES('self_awake_initial_anchor',?)").run(String(now))
  const initial = Number(db.prepare("SELECT value FROM realm_meta WHERE key='self_awake_initial_anchor'").get()?.value)
  return Number(latest ?? initial) + maxWakeIntervalMs
}

function latestActivation(database: EdenDatabase, sessionId?: string) {
  const db = database.connection
  const latest = sessionId ? db.prepare('SELECT started_at AS stamp FROM self_awake_activations WHERE session_id=? ORDER BY started_at DESC,run_id DESC LIMIT 1').get(sessionId)?.stamp
    : db.prepare('SELECT started_at AS stamp FROM self_awake_activations WHERE legacy_scope=1 ORDER BY started_at DESC,run_id DESC LIMIT 1').get()?.stamp
  return latest
}

function externalAnchor(filename?: string, sessionId?: string): number | undefined {
  if (filename && existsSync(filename)) {
    const state = JSON.parse(readFileSync(filename, 'utf8'))
    if (sessionId && state.session_id !== sessionId) throw new Error('MonOs schedule belongs to another session')
    const anchor = state.wake_anchor_at ?? state.last_event?.occurred_at ?? state.last_run_at
    const parsed = Date.parse(anchor)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
