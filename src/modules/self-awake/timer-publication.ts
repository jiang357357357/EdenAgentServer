import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { EdenDatabase } from '@eden/store'

/** Agent's single pending row is the durable outbox; MonOs owns actual timed activation. */
export class SelfAwakeTimerPublication {
  private timer: ReturnType<typeof setInterval> | undefined
  private error: string | undefined
  constructor(private readonly database: EdenDatabase, private readonly stateFile?: string, private readonly external = Boolean(stateFile)) {}
  get fault() { return this.error }
  assertAvailable(): void { if (this.external && !this.stateFile) throw new Error('MonOs timer delivery requires scheduleStateFile; local scheduling is disabled') }
  start() {
    if (this.timer || !this.external) return
    const tick = () => { try { this.publish() } catch { /* The pending row is retained for retry; fault is exposed in health. */ } }
    tick()
    this.timer = setInterval(tick, 1000)
    this.timer.unref()
  }
  close() { clearInterval(this.timer); this.timer = undefined }
  publish(): void {
    try { this.assertAvailable(); if (!this.stateFile) return; this.deliver(); this.error = undefined }
    catch (error) { this.error = `Self-awake timer saved, MonOs delivery pending: ${error instanceof Error ? error.message : String(error)}`; throw new Error(this.error) }
  }
  private deliver(): void {
    const row = this.database.connection.prepare(`SELECT j.* FROM jobs j WHERE j.kind='self_awake' AND j.state='queued'
      AND COALESCE(json_extract(j.payload_json,'$.scheduler'),'')!='monos'
      AND NOT EXISTS (SELECT 1 FROM self_awake_timer_publications p WHERE p.job_id=j.id) LIMIT 1`).get()
    if (!row) return
    const directory = path.join(path.dirname(this.stateFile!), 'schedule_requests')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, `${row.id}.json`), temporary = `${filename}.tmp`
    const payload = JSON.parse(String(row.payload_json))
    const request = { request_id: row.id, requested_by: 'eden-agent', requested_at: new Date(Number(row.created_at)).toISOString(),
      next_wake_at: new Date(Number(row.due_at)).toISOString(), after_minutes: Math.max(1, Math.ceil((Number(row.due_at) - Date.now()) / 60000)),
      reason: payload.trigger?.reason ?? payload.prompt ?? 'Agent self-awake timer' }
    try { writeFileSync(temporary, JSON.stringify(request), { mode: 0o600 }); renameSync(temporary, filename) }
    finally { rmSync(temporary, { force: true }) }
    this.database.connection.prepare('INSERT OR IGNORE INTO self_awake_timer_publications(job_id,published_at) VALUES (?,?)').run(row.id!, Date.now())
  }
}
