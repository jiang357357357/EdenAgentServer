import { accountFilter, currentAccount, SessionOwnership } from '../accounts/index.ts'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { EdenDatabase } from '@eden/store'
import { modelContextUsage, runtimeCheckpointSchema, runtimeOriginSchema, sessionPurposeSchema, sessionSourceChannelSchema, toJson } from '@eden/api'
import type { JsonValue, RuntimeCheckpoint, RuntimeOrigin, SessionPurpose, SessionSourceChannel } from '@eden/api'
import type { SessionSummary } from './contracts.ts'
import { SessionEvents } from './session-events.ts'
import { latestMetadataEvent } from './session-metadata-query.ts'
import { readReplyTimer } from './reply-timer-query.ts'
import { sessionStorage } from './session-storage.ts'
import { privateQqCheckpoint, privateMemoryCheckpoint } from '../tool-results/index.ts'
import { MemoryRepository } from '../memories/index.ts'
import { SessionContextDeletion } from './history/context-deletion.ts'

interface SessionMetadata {
  participants: JsonValue[]
  environment: JsonValue
  metadataSeq: string
  metadataUpdatedAt: number
}

export class SessionRepository {
  readonly events: SessionEvents
  readonly ownership: SessionOwnership
  constructor(readonly database: EdenDatabase, readonly origin: RuntimeOrigin) {
    this.events = new SessionEvents(database)
    this.ownership = new SessionOwnership(database)
  }

  create(title: string, participants: JsonValue[] = [], environment: JsonValue = null,
    classification: { purpose: SessionPurpose; sourceChannel: SessionSourceChannel } = { purpose: 'user_chat', sourceChannel: 'app' }): SessionSummary {
    if (classification.sourceChannel === 'qq' && this.origin !== 'mon') throw new Error('QQ sessions belong to Mon')
    if (classification.sourceChannel === 'qq' && (classification.purpose !== 'user_chat' || participants.length !== 1))
      throw new Error('QQ sessions require one acting participant')
    const now = Date.now()
    const id = randomUUID()
    const event = this.database.transaction(() => {
      this.database.connection.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(id, title, this.origin, 'active', now, now)
      this.database.connection.prepare('UPDATE session_classification SET purpose=?,source_channel=? WHERE session_id=?')
        .run(classification.purpose, classification.sourceChannel, id)
      const account = currentAccount()
      const key = account?.key ?? this.database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value
      if (typeof key === 'string') this.ownership.assign(id, key)
      return this.events.insert(id, null, 'session.created', {
        participants, environment, title, titleSource: title.trim() ? 'user' : null,
        purpose: classification.purpose, sourceChannel: classification.sourceChannel,
      })
    })
    this.events.publish(event)
    return this.read(id)
  }

  read(id: string): SessionSummary {
    this.ownership.assert(id)
    const row = this.database.connection.prepare(`SELECT s.*,c.purpose,c.source_channel,(a.session_id IS NOT NULL) AS archived FROM sessions s
      JOIN session_classification c ON c.session_id=s.id LEFT JOIN session_archives a ON a.session_id=s.id
      WHERE s.id=? AND s.origin=? AND s.status!='deleted'`).get(id, this.origin)
    if (!row) throw new Error('Session not found')
    const metadata = this.metadata(id, Number(row.created_at))
    const latestUsage = this.events.latestUsagePayload(id)
    const usage = latestUsage ? modelContextUsage(latestUsage) : undefined
    const runningInput = this.database.connection.prepare("SELECT 1 FROM inputs WHERE session_id=? AND state IN ('queued','running') LIMIT 1").get(id)
    return {
      ...usage,
      id: String(row.id), title: String(row.title), titleSource: this.titleSource(id, String(row.title)) ?? 'pending',
      status: row.status === 'closed' ? 'closed' : 'active', executionStatus: runningInput ? 'busy' : 'idle',
      runtimeOrigin: runtimeOriginSchema.parse(row.origin),
      archived: row.archived === 1,
      purpose: sessionPurposeSchema.parse(row.purpose), sourceChannel: sessionSourceChannelSchema.parse(row.source_channel),
      participants: metadata.participants, environment: metadata.environment,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  /** Synchronization needs the current roster/environment, not usage, titles or input queue state. */
  readMetadata(id: string): SessionMetadata {
    this.ownership.assert(id)
    const row = this.database.connection.prepare("SELECT created_at FROM sessions WHERE id=? AND origin=? AND status!='deleted'").get(id, this.origin)
    if (!row) throw new Error('Session not found')
    return this.metadata(id, Number(row.created_at))
  }

  replyTimer(id: string) {
    this.readMetadata(id)
    return readReplyTimer(this.database, id)
  }

  private metadata(id: string, createdAt: number): SessionMetadata {
    const latest = latestMetadataEvent(this.database, id, ['session.created', 'session.metadata.updated'])
    const payload: Record<string, unknown> = JSON.parse(latest?.payloadJson ?? '{}')
    return {
      participants: Array.isArray(payload.participants) ? payload.participants.map(toJson) : [],
      environment: toJson(payload.environment ?? null),
      metadataSeq: String(latest?.seq ?? 0n), metadataUpdatedAt: latest?.createdAt ?? createdAt,
    }
  }

  list(limit = 100, includeClosed = false, includeBackground = true, purpose?: SessionPurpose, sourceChannel?: SessionSourceChannel, archived?: boolean): SessionSummary[] {
    return this.listIds(limit, includeClosed, includeBackground, purpose, sourceChannel, archived).map(id => this.read(id))
  }

  /** Snapshot ordered IDs, then recheck each summary's ownership while allowing other connections to run. */
  async listAsync(limit = 100, includeClosed = false, includeBackground = true, purpose?: SessionPurpose,
    sourceChannel?: SessionSourceChannel, signal?: AbortSignal, archived?: boolean): Promise<SessionSummary[]> {
    await yieldToEventLoop(undefined, { signal })
    const ids = this.listIds(limit, includeClosed, includeBackground, purpose, sourceChannel, archived)
    const sessions: SessionSummary[] = []
    let count = 0, started = performance.now()
    for (const id of ids) {
      if (count >= 25 || performance.now() - started >= 8) {
        await yieldToEventLoop(undefined, { signal })
        count = 0; started = performance.now()
      }
      signal?.throwIfAborted()
      // A deleted session or revoked owner rejects the entire read, never a partial authorized snapshot.
      sessions.push(this.read(id))
      count++
    }
    signal?.throwIfAborted()
    return sessions
  }

  private listIds(limit: number, includeClosed: boolean, includeBackground: boolean,
    purpose?: SessionPurpose, sourceChannel?: SessionSourceChannel, archived?: boolean): string[] {
    const defaultApp = !includeBackground && !purpose && !sourceChannel
    return this.database.connection.prepare(`SELECT s.id FROM sessions s JOIN session_classification c ON c.session_id=s.id
      LEFT JOIN session_archives a ON a.session_id=s.id
      WHERE ${accountFilter(this.database, 's.id')} AND s.origin=? AND s.status!='deleted' AND (? OR s.status='active')
      AND (? IS NULL OR c.purpose=?) AND (? IS NULL OR c.source_channel=?)
      AND (?=0 OR (c.purpose='user_chat' AND c.source_channel='app'))
      AND (? IS NULL OR (a.session_id IS NOT NULL)=?)
      ORDER BY s.updated_at DESC LIMIT ?`)
      .all(this.origin, Number(includeClosed), purpose ?? null, purpose ?? null, sourceChannel ?? null, sourceChannel ?? null,
        Number(defaultApp), archived === undefined ? null : Number(archived), archived === undefined ? null : Number(archived),
        Math.min(limit, 1000)).map(row => String(row.id))
  }

  rename(id: string, title: string): SessionSummary {
    this.readMetadata(id)
    this.updateTitle(id, title, 'user')
    return this.read(id)
  }

  setArchived(id: string, archived: boolean): SessionSummary {
    const current = this.read(id)
    if (current.archived === archived) return current
    const event = this.database.transaction(() => {
      const now = Date.now()
      if (archived) this.database.connection.prepare('INSERT INTO session_archives VALUES(?,?)').run(id, now)
      else this.database.connection.prepare('DELETE FROM session_archives WHERE session_id=?').run(id)
      this.database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, id)
      return this.events.insert(id, null, 'session.archive_updated', { archived })
    })
    this.events.publish(event)
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
    const latest = latestMetadataEvent(this.database, id, ['session.title_updated', 'session.renamed'])
    if (latest) {
      if (latest.kind === 'session.renamed') return 'user'
      const payload = JSON.parse(latest.payloadJson) as { titleSource?: unknown }
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
    return sessionStorage('会话检查点读取失败', () => {
      const row = this.database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(sessionId)
      const checkpoint = row ? runtimeCheckpointSchema.parse(JSON.parse(String(row.checkpoint_json))) : undefined
      return checkpoint ? privateQqCheckpoint(this.modelCheckpoint(checkpoint)) : undefined
    })
  }

  assertContextReady(sessionId: string): void {
    this.read(sessionId)
  }

  modelCheckpoint(snapshot: RuntimeCheckpoint, actorId?: string): RuntimeCheckpoint {
    this.assertContextReady(snapshot.sessionId)
    return privateMemoryCheckpoint(new SessionContextDeletion(this.database).project(runtimeCheckpointSchema.parse(snapshot), actorId),
      new MemoryRepository(this.database).credentialValues())
  }

  saveCheckpoint(snapshot: RuntimeCheckpoint, turnId: string): void {
    const checkpoint = this.modelCheckpoint(snapshot)
    const event = sessionStorage('会话检查点提交失败', () => this.database.transaction(() => {
      this.database.connection.prepare(`INSERT INTO runtime_checkpoints VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at`)
        .run(checkpoint.sessionId, JSON.stringify(checkpoint), Date.now())
      return this.events.insert(checkpoint.sessionId, turnId, 'runtime.checkpoint', { entries: checkpoint.entries.length })
    }))
    this.events.publish(event)
  }
}
