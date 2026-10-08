import { logDiagnostic } from '../logging/index.ts'
import { ProjectionDelivery } from './projection-delivery.ts'
import { directorProjection } from './director-projection.ts'
import { createHash } from 'node:crypto'
import { MonClient } from '@eden/integrations'
import type { JsonValue } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'
import type { MonConnection, MonConnectionRepository } from './connection-repository.ts'
import { MonProjectionConfigurationRequired, sessionProjectionKinds } from './session-projection.ts'
import type { MonSessionProjection } from './session-projection.ts'
import { messageProjection } from './message-projection.ts'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { migrateDestination, monDestination } from './destination.ts'
import { maxProjectionAttempts, permanentProjectionFailure, projectionError } from './projection-policy.ts'
const syncEventKinds = [...sessionProjectionKinds, 'director.planned', 'director.beat.started', 'director.beat.completed', 'director.failed']
const metadataKinds = ['session.created', 'session.metadata.updated']
interface SyncProgress { afterSeq: string; attempts: number; retryAt: number }
interface WaitingMetadata { destination: string; configuration: string; observedSeq: string }
export class MonSyncWorker {
  private readonly delivery: ProjectionDelivery
  private readonly abort = new AbortController()
  private timer: ReturnType<typeof setInterval> | undefined
  private task: Promise<void> | undefined
  private readonly waitingForMetadata = new Map<string, WaitingMetadata>()
  constructor(private readonly sessions: SessionRepository, private readonly connections: MonConnectionRepository,
    private readonly projection: MonSessionProjection,
    private readonly clientFor: (id: string, connection: MonConnection) => MonClient = (_id, connection) => new MonClient(connection.coreBaseUrl, connection.coreToken)) { this.delivery = new ProjectionDelivery(sessions.database) }
  start() {
    if (this.timer || this.abort.signal.aborted) return
    const tick = () => {
      if (this.task) return
      this.task = this.syncPending().catch(error => { logDiagnostic({ event: 'mon.sync.discovery_failed', message: 'Mon 同步任务扫描失败，待同步事件仍保留在数据库中。', origin: this.sessions.origin, error }, 'error') })
        .finally(() => { this.task = undefined })
    }
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick()
  }
  /** One bounded pass; the timer and deterministic recovery checks share this path. */
  async syncPending() {
    if (!await this.yield()) return
    const db = this.sessions.database.connection
    const rows = db.prepare(`SELECT c.session_id FROM mon_connections c JOIN sessions s ON s.id=c.session_id
      WHERE s.status!='deleted' ORDER BY c.session_id`).all()
    let processed = 0, started = performance.now()
    for (const row of rows) {
      if (++processed > 32 || performance.now() - started >= 8) {
        if (!await this.yield()) return
        processed = 1; started = performance.now()
      }
      if (this.abort.signal.aborted) return
      const sessionId = String(row.session_id), connection = this.connections.readForSync(sessionId)
      if (db.prepare('SELECT 1 FROM qq_group_sessions WHERE session_id=?').get(sessionId)) continue
      if (!connection) continue
      await this.syncSession(sessionId, connection)
    }
  }

  private async syncSession(sessionId: string, connection: MonConnection) {
    const db = this.sessions.database.connection
    migrateDestination(this.sessions.database, sessionId, connection)
    const destination = monDestination(connection), key = createHash('sha256').update(destination).digest('hex')
    const progress = this.progress(sessionId, key)
    if (progress.retryAt < 0 || progress.retryAt > Date.now()) return
    let latest = 0n
    let configuration: string | undefined
    try {
      latest = this.sessions.events.latestSequence(sessionId)
      if (BigInt(progress.afterSeq) >= latest || this.stillWaiting(sessionId, key, latest)) return
      const batch = this.sessions.events.projectionBatch(sessionId, progress.afterSeq, syncEventKinds, 100)
      if (batch.throughSeq === progress.afterSeq) return
      if (batch.events.length) {
        configuration = this.projectionConfiguration(sessionId, key, latest)
        if (configuration === undefined) return
        const client = this.clientFor(sessionId, connection)
        const remoteId = await this.projection.ensure(client, sessionId, destination, this.abort.signal)
        await this.deliverEvents(batch.events, client, sessionId, key, remoteId)
      }
      db.prepare('UPDATE mon_sync_progress SET after_seq=?,attempts=0,retry_at=0,error=NULL WHERE session_id=? AND destination_key=?')
        .run(batch.throughSeq, sessionId, key)
    } catch (error) {
      if (this.abort.signal.aborted) return
      if (error instanceof MonProjectionConfigurationRequired && configuration !== undefined) {
        this.waitingForMetadata.set(sessionId, { destination: key, configuration, observedSeq: String(latest) })
        db.prepare('UPDATE mon_sync_progress SET attempts=0,retry_at=0,error=? WHERE session_id=? AND destination_key=?')
          .run(error.message, sessionId, key)
        return
      }
      const attempts = Math.min(maxProjectionAttempts, progress.attempts + 1)
      const paused = permanentProjectionFailure(error) || attempts >= maxProjectionAttempts
      db.prepare('UPDATE mon_sync_progress SET attempts=?,retry_at=?,error=? WHERE session_id=? AND destination_key=?')
        .run(attempts, paused ? -1 : Date.now() + Math.min(300000, 2000 * 2 ** attempts), projectionError(error), sessionId, key)
      if (paused) this.sessions.events.append(sessionId, null, 'mon.sync.paused', { attempts, error: projectionError(error) })
    }
  }
  private projectionConfiguration(sessionId: string, destination: string, latest: bigint): string | undefined {
    const metadata = this.sessions.readMetadata(sessionId)
    const configuration = JSON.stringify({ participants: metadata.participants, environment: metadata.environment })
    const waiting = this.waitingForMetadata.get(sessionId)
    if (backgroundEnvironment(metadata.environment) || (waiting?.destination === destination && waiting.configuration === configuration)) {
      this.waitingForMetadata.set(sessionId, { destination, configuration, observedSeq: String(latest) })
      return undefined
    }
    this.waitingForMetadata.delete(sessionId)
    return configuration
  }
  private progress(sessionId: string, destination: string): SyncProgress {
    const db = this.sessions.database.connection
    const row = db.prepare('SELECT after_seq,attempts,retry_at FROM mon_sync_progress WHERE session_id=? AND destination_key=?').get(sessionId, destination)
    if (row) return { afterSeq: String(row.after_seq), attempts: Number(row.attempts), retryAt: Number(row.retry_at) }
    db.prepare('INSERT INTO mon_sync_progress VALUES(?,?,\'0\',0,0,NULL)').run(sessionId, destination)
    return { afterSeq: '0', attempts: 0, retryAt: 0 }
  }
  private stillWaiting(sessionId: string, destination: string, latest: bigint): boolean {
    const waiting = this.waitingForMetadata.get(sessionId)
    if (!waiting || waiting.destination !== destination) return false
    if (BigInt(waiting.observedSeq) >= latest) return true
    if (this.sessions.events.latestKindSequence(sessionId, metadataKinds) > BigInt(waiting.observedSeq)) return false
    waiting.observedSeq = String(latest)
    return true
  }
  private async yield(): Promise<boolean> {
    if (this.abort.signal.aborted) return false
    try { await yieldToEventLoop(undefined, { signal: this.abort.signal }); return !this.abort.signal.aborted }
    catch (error) { if (this.abort.signal.aborted) return false; throw error }
  }
  async close() { if (this.timer) clearInterval(this.timer); this.abort.abort(); await this.task }

  private async deliverEvents(events: ReturnType<SessionRepository['events']['list']>, client: MonClient, sessionId: string, key: string, remoteId: string) {
    for (const event of events) {
      if (event.kind === 'agent.message_end') {
        const body = messageProjection(this.sessions, event)
        if (body) await this.delivery.deliver(client, sessionId, key, event.id, remoteId, 'message', body, this.abort.signal)
      }
      const director = directorProjection(event)
      if (director) await this.delivery.deliver(client, sessionId, key, event.id, remoteId, 'director', director, this.abort.signal)
    }
  }
}

function backgroundEnvironment(environment: JsonValue): boolean {
  return Boolean(environment && typeof environment === 'object' && !Array.isArray(environment)
    && (environment.sessionPurpose === 'self_awake' || environment.subagent))
}
