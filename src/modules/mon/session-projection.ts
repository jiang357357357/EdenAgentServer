import { createHash } from 'node:crypto'
import { z } from 'zod'
import { toJson } from '@eden/api'
import type { MonClient } from '@eden/integrations'
import type { SessionRepository, SessionSummary } from '../sessions/index.ts'
import { beginProjectionAttempt, existingProjection, failProjection } from './projection-policy.ts'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export const sessionProjectionKinds = ['session.created', 'session.metadata.updated', 'session.title_updated', 'session.renamed', 'session.closed', 'agent.message_end'] as const

/** A local draft is valid, but Core requires an explicitly configured participant roster. */
export class MonProjectionConfigurationRequired extends Error {
  constructor(message = '会话尚未配置有效的 Core 助手；请为当前会话选择助手后再同步。') { super(message) }
}

function participantIds(session: SessionSummary): number[] {
  if (session.runtimeOrigin !== 'mon') throw new MonProjectionConfigurationRequired('只有伊甸园会话可以同步到 Core。')
  // Matches Core AgentSessionParticipantsUpdateSerializer, including numeric string IDs.
  if (!session.participants.length || session.participants.length > 8) throw new MonProjectionConfigurationRequired()
  const ids = session.participants.map(actor => {
    const raw = actor && typeof actor === 'object' && !Array.isArray(actor) ? actor.assistantId : undefined
    const id = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new MonProjectionConfigurationRequired()
    return id
  })
  if (new Set(ids).size !== ids.length) throw new MonProjectionConfigurationRequired('参与助手不能重复；请更新当前会话的助手配置后再同步。')
  return ids
}

function projection(sessions: SessionRepository, sessionId: string) {
  const session = sessions.read(sessionId)
  const assistants = participantIds(session)
  const actors = session.participants.filter((item): item is Record<string, import('@eden/api').JsonValue> => !!item && typeof item === 'object' && !Array.isArray(item))
  const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? value : null
  const updatedAt = sessions.events.latestKindTime(sessionId, sessionProjectionKinds) ?? session.createdAt
  return toJson({ source: 'monagent', external_session_id: session.id, assistant: assistants[0], character: scalar(actors[0]?.characterId),
    title: session.title, mode: 'companion', director_policy: {}, status: session.status, last_message_at: new Date(updatedAt).toISOString(),
    session_payload: { id: session.id, title: session.title, status: session.status, participants: session.participants,
      environment: session.environment, participantAssistantIDs: assistants, time: { created: session.createdAt, updated: updatedAt } },
    session_events_payload: [],
  })
}
/** Durable idempotent Core session/participant projection, also used before first speech. */
export class MonSessionProjection {
  private readonly pending = new Map<string, Promise<string>>()
  constructor(private readonly sessions: SessionRepository) {
    sessions.database.connection.prepare("UPDATE mon_projection_outbox SET state='unknown',error='Host restarted before response confirmation' WHERE state='running'").run()
  }
  ensure(client: MonClient, sessionId: string, destination: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const db = this.sessions.database.connection
    if (db.prepare("SELECT 1 FROM legacy_core_identities WHERE session_id=? AND state='rebind_required'").get(sessionId) ||
      db.prepare("SELECT 1 FROM legacy_core_outbox WHERE session_id=? AND state IN ('held','unknown','running') LIMIT 1").get(sessionId)) {
      throw new Error('Legacy Core identity and delivery history must be reconciled before synchronization')
    }
    const body = projection(this.sessions, sessionId)
    const destinationKey = digest(destination)
    const key = existingProjection(this.sessions.database, sessionId, destinationKey, 'session', JSON.stringify(body), digest(JSON.stringify({ destinationKey, body })))
    const existing = this.pending.get(key)
    if (existing) return existing
    const task = this.deliver(client, sessionId, key, destinationKey, body, signal)
    this.pending.set(key, task)
    void task.finally(() => this.pending.delete(key)).catch(() => {})
    return task
  }
  private async deliver(client: MonClient, sessionId: string, key: string, destination: string,
    body: import('@eden/api').JsonValue, signal: AbortSignal): Promise<string> {
    const db = this.sessions.database.connection
    db.prepare("INSERT INTO mon_projection_outbox VALUES(?,?,?,'session',?,'pending',NULL,NULL,?,?) ON CONFLICT(id) DO NOTHING")
      .run(key, sessionId, destination, JSON.stringify(body), Date.now(), Date.now())
    const row = db.prepare('SELECT state,remote_id FROM mon_projection_outbox WHERE id=?').get(key)!
    if (row.state === 'applied') return String(row.remote_id)
    beginProjectionAttempt(this.sessions.database, key)
    // Core upserts by source/external_session_id; participant PUT replaces the full set.
    db.prepare("UPDATE mon_projection_outbox SET state='running',error=NULL,updated_at=? WHERE id=?").run(Date.now(), key)
    try {
      signal.throwIfAborted()
      const response = await client.post('/api/agent/sessions/', body, signal)
      const remote = z.object({ id: z.union([z.number().int().positive().safe(), z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)]) }).parse(response)
      const payload = body as Record<string, import('@eden/api').JsonValue>
      const metadata = payload.session_payload as Record<string, import('@eden/api').JsonValue>
      await client.put(`/api/agent/sessions/${remote.id}/participants/`, { assistant_ids: metadata.participantAssistantIDs!, mode: 'companion' }, signal)
      db.prepare("UPDATE mon_projection_outbox SET state='applied',remote_id=?,updated_at=? WHERE id=?").run(String(remote.id), Date.now(), key)
      return String(remote.id)
    } catch (error) {
      failProjection(this.sessions.database, key, error)
      throw error
    }
  }
}
