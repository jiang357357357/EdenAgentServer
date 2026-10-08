import { publishWakeActivation } from './activation-publication.ts'
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { EdenDatabase } from '@eden/store'
import type { SQLOutputValue } from 'node:sqlite'
import { assertScopedScheduler, selfAwakeScopeState } from './scope-paths.ts'

/** Session revisions are a durable outbox; MonOs owns actual timed activation. */
export class SelfAwakeTimerPublication {
  private timer: ReturnType<typeof setInterval> | undefined
  private error: string | undefined
  private activationCursor = ''
  private publicationCursor = ''
  private readonly activationErrors = new Map<string, string>()
  constructor(private readonly database: EdenDatabase, private readonly stateFile?: string, private readonly external = Boolean(stateFile)) {}
  get fault() { return this.error ?? this.activationErrors.values().next().value }
  assertAvailable(scoped = false): void {
    if (this.external && !this.stateFile) throw new Error('MonOs timer delivery requires scheduleStateFile; local scheduling is disabled')
    if (scoped && this.external && this.stateFile) assertScopedScheduler(this.stateFile)
  }
  start() {
    if (this.timer || !this.external) return
    const tick = () => { try { this.publish() } catch { /* The pending row is retained for retry; fault is exposed in health. */ } }
    tick()
    this.timer = setInterval(tick, 1000)
    this.timer.unref()
  }
  close() { clearInterval(this.timer); this.timer = undefined }
  publish(sessionId?: string): void {
    try {
      this.assertAvailable(); if (!this.stateFile) return
      this.error = undefined
      if (!sessionId) {
        try { publishWakeActivation(this.database, this.stateFile) }
        catch (error) { this.error = error instanceof Error ? error.message : String(error) }
      }
      this.deliver(sessionId); this.activations()
      if (sessionId) {
        const failure = this.database.connection.prepare('SELECT publication_error FROM self_awake_session_schedules WHERE session_id=?').get(sessionId)?.publication_error
        if (failure) throw new Error(String(failure))
      }
    }
    catch (error) { this.error = `Self-awake timer saved, MonOs delivery pending: ${error instanceof Error ? error.message : String(error)}`; throw new Error(this.error) }
  }
  private deliver(sessionId?: string): void {
    const rows = this.database.connection.prepare(`SELECT s.*,j.due_at,j.payload_json FROM self_awake_session_schedules s
      LEFT JOIN jobs j ON j.id=s.job_id WHERE s.published_revision<s.revision AND (? IS NULL OR s.session_id=?)
      AND (? IS NOT NULL OR s.session_id>?) ORDER BY s.session_id LIMIT 32`).all(sessionId ?? null, sessionId ?? null, sessionId ?? null, this.publicationCursor)
    if (!sessionId) this.publicationCursor = rows.length < 32 ? '' : String(rows.at(-1)!.session_id)
    if (!rows.length) return
    this.assertAvailable(true)
    for (const row of rows) {
      try {
        this.writeRequest(row)
        this.database.connection.prepare(`UPDATE self_awake_session_schedules SET published_revision=?,publication_error=NULL
          WHERE session_id=? AND revision=?`).run(row.revision!, row.session_id!, row.revision!)
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
        this.database.connection.prepare('UPDATE self_awake_session_schedules SET publication_error=? WHERE session_id=? AND publication_error IS NOT ?').run(message, row.session_id!, message)
      }
    }
  }
  private writeRequest(row: Record<string, SQLOutputValue>): void {
    const stateFile = selfAwakeScopeState(this.stateFile!, String(row.session_id))
    const directory = path.join(path.dirname(stateFile), 'schedule_requests')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, `${row.revision}.json`), temporary = `${filename}.tmp`
    const payload = row.payload_json ? JSON.parse(String(row.payload_json)) : {}
    const request = { schema_version: 'self-awake.schedule.v2', session_id: row.session_id, revision: row.revision,
      legacy_request_id: row.legacy_request_id,
      action: row.job_id ? 'schedule' : 'cancel', request_id: row.job_id ?? `cancel:${row.session_id}:${row.revision}`, job_id: row.job_id,
      requested_by: 'eden-agent', requested_at: new Date(Number(row.revision)).toISOString(),
      next_wake_at: row.job_id ? new Date(Number(row.due_at)).toISOString() : null,
      after_minutes: row.job_id ? Math.max(1, Math.ceil((Number(row.due_at) - Date.now()) / 60000)) : null,
      reason: payload.trigger?.reason ?? payload.prompt ?? 'Agent session self-awake timer' }
    try { writeFileSync(temporary, JSON.stringify(request), { mode: 0o600 }); renameSync(temporary, filename) }
    finally { rmSync(temporary, { force: true }) }
  }
  private activations(): void {
    const rows = this.database.connection.prepare(`SELECT session_id FROM self_awake_session_schedules
      WHERE session_id>? ORDER BY session_id LIMIT 32`).all(this.activationCursor)
    for (const row of rows) {
      this.activationCursor = String(row.session_id)
      try {
        publishWakeActivation(this.database, selfAwakeScopeState(this.stateFile!, this.activationCursor), this.activationCursor)
        this.activationErrors.delete(this.activationCursor)
      } catch (error) { this.activationErrors.set(this.activationCursor, error instanceof Error ? error.message : String(error)) }
    }
    if (rows.length < 32) this.activationCursor = ''
  }
}
