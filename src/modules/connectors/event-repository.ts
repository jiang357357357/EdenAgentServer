import { randomUUID } from 'node:crypto'
import { connectorPublishedEventSchema, toJson } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'
import type { JobRepository } from '../jobs/index.ts'
import type { ConnectorRepository } from './repository.ts'
import type { ConnectorCatalog } from './catalog.ts'
import type { DatabaseSync } from 'node:sqlite'
import { connectorEventContext } from '../../model-prompts/connectors.ts'
import { wakeRoleFromAuthor } from '../self-awake/index.ts'
export class ConnectorEventRepository {
  constructor(private readonly sessions: SessionRepository, private readonly connectors: ConnectorRepository,
    private readonly catalog: ConnectorCatalog, private readonly jobs: JobRepository) { }
  accept(connectorId: string, generation: string, raw: unknown) {
    const input = connectorPublishedEventSchema.parse(raw)
    const payload = JSON.stringify(input.payload)
    if (Buffer.byteLength(payload) > 256 * 1024) throw new Error('Connector event exceeds 256 KiB')
    const result = this.sessions.database.transaction(() => {
      const connector = this.connectors.read(connectorId)
      if (connector.generation !== generation || connector.desiredState !== 'connected' || !['connecting', 'connected'].includes(connector.runtimeState)) throw new Error('Stale or inactive connector event producer')
      const db = this.sessions.database.connection
      const old = db.prepare('SELECT id,event_type,payload_json,job_id FROM connector_events WHERE connector_id=? AND external_id=?').get(connectorId, input.externalId)
      if (old) {
        if (old.event_type !== input.eventType || old.payload_json !== payload) throw new Error('Connector external event ID was reused with different content')
        return { id: String(old.id), jobId: old.job_id === null ? null : String(old.job_id), duplicate: true, events: [] }
      }
      this.catalog.assertEvent(connector.connectorKey, input.eventType, input.payload)
      const id = randomUUID(), now = Date.now(), settings = connector.settings as Record<string, unknown>
      const bound = typeof settings.boundSessionId === 'string' ? settings.boundSessionId : undefined
      const { suppression, jobId, event } = this.routeBoundEvent(bound, settings, db, connectorId, now, null, null, id, connector, input, undefined)
      db.prepare('INSERT INTO connector_events VALUES(?,?,?,?,?,?,?,?,?)').run(id, connectorId, input.externalId, input.eventType, payload, bound ?? null, jobId, suppression, now)
      const notifications = event ? [event] : []
      for (const row of db.prepare("SELECT sh.session_id FROM connector_session_shares sh JOIN sessions s ON s.id=sh.session_id WHERE sh.connector_id=? AND s.status='active'").all(connectorId)) {
        const sessionId = String(row.session_id)
        if (this.connectors.accessible(connectorId, sessionId)) notifications.push(this.sessions.events.insert(sessionId, null, 'connector.event', { connectorId, eventId: id, eventType: input.eventType }))
      }
      return { id, jobId, duplicate: false, events: notifications }
    })
    for (const event of result.events) this.sessions.events.publish(event)
    return { id: result.id, jobId: result.jobId, duplicate: result.duplicate }
  }
  private routeBoundEvent(bound: string | undefined, settings: Record<string, unknown>, db: DatabaseSync, connectorId: string, now: number, suppression: string | null, jobId: string | null, id: string, connector: ReturnType<ConnectorRepository['read']>, input: { eventType: string }, event: ReturnType<SessionRepository['events']['insert']> | undefined) {
    if (bound) {
      const session = this.sessions.read(bound)
      if (session.status === 'active') {
        if (settings.selfAwakeOnEvent === true) {
          const pending = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE session_id=? AND kind='connector.event' AND state IN ('queued','running','dispatched','unknown')").get(bound)
          const owner = this.sessions.ownership.owner(bound)
          let roleScope: string | undefined
          try { if (this.sessions.origin !== 'mon' || owner) roleScope = wakeRoleFromAuthor(this.sessions.origin, owner ?? '', session.participants[0] ?? {})?.key }
          catch { suppression = 'connector_event_invalid_actor' }
          if (Number(pending?.count) >= 1000) suppression = 'connector_event_queue_full'
          else if (session.participants.length > 1) suppression = 'connector_event_requires_single_actor'
          else if (this.sessions.origin === 'mon' && !owner) suppression = 'connector_event_owner_missing'
          else if (!suppression) jobId = this.jobs.scheduleInTransaction({
            kind: 'connector.event', sessionId: bound, dueAt: now,
            key: `connector-event:${id}`, causationId: id, depth: 0, payload: {
              eventId: id,
              ...(roleScope ? { roleScope } : {}),
              trigger: {
                type: 'connector', source: connector.connectorKey, reason: input.eventType,
                details: connectorEventContext(id)
              }
            }
          }).id
        }
        event = this.sessions.events.insert(bound, null, 'connector.event', { connectorId, eventId: id, eventType: input.eventType, jobId, suppression })
      } else suppression = 'bound_session_closed'
    }
    return { suppression, jobId, event }
  }

  readForSession(sessionId: string, eventId: string) {
    this.sessions.read(sessionId)
    const row = this.sessions.database.connection.prepare(`SELECT e.*,j.kind AS job_kind,j.state AS job_state,s.job_id AS published_job,
      s.revision AS schedule_revision,s.published_revision,s.publication_error FROM connector_events e
      LEFT JOIN jobs j ON j.id=e.job_id LEFT JOIN self_awake_session_schedules s ON s.session_id=e.session_id
      WHERE e.id=?`).get(eventId)
    if (!row || !this.connectors.accessible(String(row.connector_id), sessionId) || (row.session_id !== sessionId && !this.isSharedEvent(row, sessionId))) throw new Error('Connector event is not available to this session')
    return toJson({
      id: String(row.id), connectorId: String(row.connector_id), externalId: String(row.external_id),
      eventType: String(row.event_type), payload: JSON.parse(String(row.payload_json)), createdAt: Number(row.created_at), wake: wakeStatus(row, this.jobs.usesExternalSelfAwake())
    })
  }
  listForSession(sessionId: string, options: { before?: number | undefined; after?: number | undefined; limit?: number | undefined } = {}) {
    this.sessions.read(sessionId)
    if (options.before !== undefined && options.after !== undefined) throw new Error('Choose either before or after')
    const limit = options.limit ?? 50, forward = options.after !== undefined
    const rows = this.sessions.database.connection.prepare(`SELECT e.rowid AS cursor,e.id,e.connector_id,e.event_type,e.created_at,e.job_id,e.suppression,j.kind AS job_kind,j.state AS job_state,
      s.job_id AS published_job,s.revision AS schedule_revision,s.published_revision,s.publication_error
      FROM connector_events e LEFT JOIN jobs j ON j.id=e.job_id LEFT JOIN self_awake_session_schedules s ON s.session_id=e.session_id
      WHERE (e.session_id=? OR EXISTS(SELECT 1 FROM connector_session_shares sh JOIN connectors c ON c.id=sh.connector_id
        WHERE sh.connector_id=e.connector_id AND sh.session_id=? AND json_extract(c.settings_json,'$.boundSessionId')=e.session_id
        AND ((SELECT account_key FROM session_owners WHERE session_id=e.session_id)=(SELECT account_key FROM session_owners WHERE session_id=?)
          OR ((SELECT value FROM realm_meta WHERE key='origin')='local' AND NOT EXISTS(SELECT 1 FROM session_owners WHERE session_id IN (e.session_id,?))))))
      AND e.rowid ${forward ? '>' : '<'} ? ORDER BY e.rowid ${forward ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(sessionId, sessionId, sessionId, sessionId, forward ? options.after! : options.before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    const page = rows.slice(0, limit)
    return { events: page.map(row => ({ id: String(row.id), connectorId: String(row.connector_id), eventType: String(row.event_type), createdAt: Number(row.created_at), wake: wakeStatus(row, this.jobs.usesExternalSelfAwake()) })),
      nextCursor: page.length ? Number(page[page.length - 1]!.cursor) : options.after ?? null, hasMore: rows.length > limit, direction: forward ? 'forward' : 'backward' }
  }
  private isSharedEvent(row: Record<string, import('node:sqlite').SQLOutputValue>, sessionId: string): boolean {
    const connector = this.connectors.read(String(row.connector_id))
    return connector.settings.boundSessionId === row.session_id && this.connectors.accessible(connector.id, sessionId)
  }
  read(connectorId: string, eventId: string) {
    this.connectors.read(connectorId)
    const row = this.sessions.database.connection.prepare('SELECT payload_json FROM connector_events WHERE id=? AND connector_id=?').get(eventId, connectorId)
    if (!row) throw new Error('Connector event was not found')
    return toJson({ id: eventId, payload: JSON.parse(String(row.payload_json)) })
  }
  list(connectorId: string, before?: number) {
    this.connectors.read(connectorId)
    const rows = this.sessions.database.connection.prepare('SELECT rowid AS cursor,* FROM connector_events WHERE connector_id=? AND rowid<? ORDER BY rowid DESC LIMIT 51')
      .all(connectorId, before ?? Number.MAX_SAFE_INTEGER)
    return toJson({
      items: rows.slice(0, 50).map(row => ({
        id: String(row.id), connectorId, externalId: String(row.external_id),
        eventType: String(row.event_type), sessionId: row.session_id, jobId: row.job_id,
        suppression: row.suppression, createdAt: Number(row.created_at)
      })), nextCursor: rows.length > 50 ? Number(rows[49]!.cursor) : null
    })
  }
}

function wakeStatus(row: Record<string, import('node:sqlite').SQLOutputValue>, external: boolean) {
  if (row.suppression) return { state: 'suppressed', reason: String(row.suppression) }
  if (!row.job_id) return { state: 'not_requested' }
  const publication = row.job_kind === 'connector.event' || !external ? 'not_required' : row.published_job !== row.job_id ? 'not_current' : row.publication_error ? 'failed'
    : Number(row.published_revision) >= Number(row.schedule_revision) ? 'published' : 'pending'
  return { state: String(row.job_state ?? 'unknown'), publication,
    ...(row.publication_error && publication === 'failed' ? { publicationError: String(row.publication_error) } : {}) }
}
