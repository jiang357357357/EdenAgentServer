import { accountFilter, currentAccount, SessionOwnership } from '../accounts/index.ts'
import { randomUUID } from 'node:crypto'
import type { EdenDatabase } from '@eden/store'
import { modelContextUsage, runtimeCheckpointSchema, runtimeOriginSchema, toJson } from '@eden/api'
import type { JsonValue, RuntimeCheckpoint, RuntimeOrigin } from '@eden/api'
import type { SessionSummary } from './contracts.ts'
import { SessionEvents } from './session-events.ts'

export class SessionRepository {
  readonly events: SessionEvents
  readonly ownership: SessionOwnership
  constructor(readonly database: EdenDatabase, readonly origin: RuntimeOrigin) {
    this.events = new SessionEvents(database)
    this.ownership = new SessionOwnership(database)
  }

  create(title: string, participants: JsonValue[] = [], environment: JsonValue = null): SessionSummary {
    const now = Date.now()
    const id = randomUUID()
    const event = this.database.transaction(() => {
      this.database.connection.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(id, title, this.origin, 'active', now, now)
      const account = currentAccount()
      const key = account?.key ?? this.database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value
      if (typeof key === 'string') this.ownership.assign(id, key)
      return this.events.insert(id, null, 'session.created', {
        participants, environment, title, titleSource: title.trim() ? 'user' : null,
      })
    })
    this.events.publish(event)
    return this.read(id)
  }

  read(id: string): SessionSummary {
    this.ownership.assert(id)
    const row = this.database.connection.prepare("SELECT * FROM sessions WHERE id=? AND origin=? AND status!='deleted'").get(id, this.origin)
    if (!row) throw new Error('Session not found')
    const created = this.database.connection.prepare("SELECT payload_json FROM events WHERE session_id=? AND kind IN ('session.created','session.metadata.updated') ORDER BY seq DESC LIMIT 1").get(id)
    const metadata: Record<string, unknown> = JSON.parse(String(created?.payload_json ?? '{}'))
    const latestUsage = this.database.connection.prepare("SELECT payload_json FROM events WHERE session_id=? AND kind='model.response' AND json_type(payload_json,'$.usage.input') IN ('integer','real') AND json_extract(payload_json,'$.usage.input')>=0 AND json_type(payload_json,'$.usage.output') IN ('integer','real') AND json_extract(payload_json,'$.usage.output')>=0 ORDER BY seq DESC LIMIT 1").get(id)
    const usage = latestUsage ? modelContextUsage(JSON.parse(String(latestUsage.payload_json))) : undefined
    return {
      ...usage,
      id: String(row.id), title: String(row.title), titleSource: this.titleSource(id, String(row.title)) ?? 'pending',
      status: row.status === 'closed' ? 'closed' : 'active', runtimeOrigin: runtimeOriginSchema.parse(row.origin),
      participants: Array.isArray(metadata.participants) ? metadata.participants.map(toJson) : [],
      environment: toJson(metadata.environment ?? null), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  list(limit = 100, includeClosed = false, includeBackground = true): SessionSummary[] {
    return this.database.connection.prepare(`SELECT id FROM sessions WHERE ${accountFilter(this.database, 'sessions.id')} AND origin=? AND status!='deleted' AND (? OR status='active')
      AND (? OR NOT EXISTS (SELECT 1 FROM self_awake_submissions s JOIN jobs j ON j.id=s.job_id WHERE j.session_id=sessions.id))
      ORDER BY updated_at DESC LIMIT ?`)
      .all(this.origin, Number(includeClosed), Number(includeBackground), Math.min(limit, 1000)).map(row => this.read(String(row.id)))
  }

  rename(id: string, title: string): SessionSummary {
    this.updateTitle(id, title, 'user')
    return this.read(id)
  }

  /** Installs the deterministic first-message title only while the session is still unnamed. */
  setFallbackTitle(id: string, title: string, turnId: string): boolean {
    this.read(id)
    if (this.titleSource(id) !== undefined) return false
    return this.updateTitle(id, title, 'fallback', turnId, new Set([undefined]))
  }

  /** Replaces an automatic fallback, but never a user-selected or newer generated title. */
  setGeneratedTitle(id: string, title: string, turnId: string): boolean {
    this.read(id)
    return this.updateTitle(id, title, 'generated', turnId, new Set(['fallback']))
  }

  private updateTitle(id: string, title: string, source: 'fallback' | 'generated' | 'user', turnId: string | null = null,
    expected?: ReadonlySet<string | undefined>): boolean {
    let event: ReturnType<SessionEvents['insert']> | undefined
    const changed = this.database.transaction(() => {
      if (expected && !expected.has(this.titleSource(id))) return false
      const now = Date.now()
      this.database.connection.prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?').run(title, now, id)
      event = this.events.insert(id, turnId, 'session.title_updated', { title, titleSource: source })
      return true
    })
    if (event) this.events.publish(event)
    return changed
  }

  private titleSource(id: string, storedTitle = ''): string | undefined {
    const latest = this.database.connection.prepare(`SELECT kind,payload_json FROM events WHERE session_id=?
      AND kind IN ('session.title_updated','session.renamed') ORDER BY seq DESC LIMIT 1`).get(id)
    if (latest) {
      if (latest.kind === 'session.renamed') return 'user'
      const payload = JSON.parse(String(latest.payload_json)) as { titleSource?: unknown }
      if (typeof payload.titleSource === 'string') return payload.titleSource
    }
    if (!storedTitle) {
      const row = this.database.connection.prepare('SELECT title FROM sessions WHERE id=?').get(id)
      storedTitle = String(row?.title ?? '')
    }
    return storedTitle.trim() ? 'user' : undefined
  }

  setMetadata(id: string, participants?: JsonValue[], environment?: JsonValue): SessionSummary {
    const current = this.read(id)
    const event = this.database.transaction(() => {
      this.database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), id)
      return this.events.insert(id, null, 'session.metadata.updated', {
        participants: participants ?? current.participants, environment: environment ?? current.environment,
      })
    })
    this.events.publish(event)
    return this.read(id)
  }

  setStatus(id: string, state: 'closed' | 'deleted'): void {
    this.read(id)
    const event = this.database.transaction(() => {
      this.database.connection.prepare('UPDATE sessions SET status=?, updated_at=? WHERE id=?').run(state, Date.now(), id)
      this.database.connection.prepare("UPDATE inputs SET state='cancelled' WHERE session_id=? AND state IN ('queued','held')").run(id)
      if (state === 'deleted') this.database.connection.prepare('DELETE FROM runtime_settings WHERE key=?').run(`command.terminal.session.${id}`)
      return this.events.insert(id, null, `session.${state}`, {})
    })
    this.events.publish(event)
  }

  checkpoint(sessionId: string): RuntimeCheckpoint | undefined {
    this.assertContextReady(sessionId)
    const row = this.database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(sessionId)
    return row ? runtimeCheckpointSchema.parse(JSON.parse(String(row.checkpoint_json))) : undefined
  }

  assertContextReady(sessionId: string): void {
    this.read(sessionId)
  }

  saveCheckpoint(snapshot: RuntimeCheckpoint, turnId: string): void {
    const event = this.database.transaction(() => {
      this.database.connection.prepare(`INSERT INTO runtime_checkpoints VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at`)
        .run(snapshot.sessionId, JSON.stringify(snapshot), Date.now())
      return this.events.insert(snapshot.sessionId, turnId, 'runtime.checkpoint', { entries: snapshot.entries.length })
    })
    this.events.publish(event)
  }
}
