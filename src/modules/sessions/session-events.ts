import { logDiagnostic } from '../logging/index.ts'
import { withoutAccount, SessionOwnership } from '../accounts/index.ts'
import { historicalContextSources } from './context-sources.ts'
import { RequestPersistence } from './request-persistence.ts'
import { StreamPersistence, restoreStreamPayload } from './stream-persistence.ts'
import { EventReadCache } from './event-read-cache.ts'
import { SessionModelHeads } from './session-model-heads.ts'
import { projectionSequences, latestKindRecord } from './event-kind-queries.ts'
import { withMessageTurnTiming } from './message-turn-timing.ts'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { JsonValue, DurableEvent } from '@eden/api'
import { durableEventSchema, jsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { SQLOutputValue } from 'node:sqlite'
import { sessionStorage } from './session-storage.ts'

export interface PendingEventRange { sessionId: string; afterSeq: string; throughSeq: string }

export class SessionEvents {
  private readonly streams = new StreamPersistence()
  private readonly reads = new EventReadCache()
  private readonly listeners = new Set<(event: DurableEvent) => void>()
  private readonly requests: RequestPersistence
  constructor(private readonly database: EdenDatabase) { this.requests = new RequestPersistence(database) }

  insert(sessionId: string, turnId: string | null, kind: string, payload: JsonValue): DurableEvent {
    return sessionStorage('会话事件写入失败', () => this.insertEvent(sessionId, turnId, kind, payload))
  }

  private insertEvent(sessionId: string, turnId: string | null, kind: string, payload: JsonValue): DurableEvent {
    const sequence = this.database.connection.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id=?')
    sequence.setReadBigInts(true)
    const row = sequence.get(sessionId)
    const event = durableEventSchema.parse({ id: randomUUID(), sessionId, turnId, seq: String(row?.seq), kind, payload, createdAt: Date.now() })
    this.database.connection.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.id, sessionId, turnId, BigInt(event.seq), kind, JSON.stringify(this.requests.encode(kind, this.streams.encode(event))), event.createdAt)
    return event
  }

  append(sessionId: string, turnId: string | null, kind: string, payload: JsonValue): DurableEvent {
    const event = sessionStorage('会话事件提交失败', () => this.database.transaction(() => this.insert(sessionId, turnId, kind, payload)))
    this.publish(event)
    return event
  }

  publish(event: DurableEvent): void {
    this.streams.committed(event)
    for (const listener of this.listeners) {
      try { withoutAccount(() => listener(event)) }
      catch (error) { logDiagnostic({ event: 'session.event.subscriber_failed', message: '会话事件订阅处理失败。', sessionId: event.sessionId, turnId: event.turnId, eventId: event.id, eventKind: event.kind, error }, 'error') }
    }
  }

  subscribe(listener: (event: DurableEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(sessionId: string, afterSeq = '0', limit = 100): DurableEvent[] {
    new SessionOwnership(this.database).assert(sessionId)
    this.reads.synchronize(this.database)
    const statement = this.database.connection.prepare('SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
    statement.setReadBigInts(true)
    return statement.all(sessionId, BigInt(afterSeq), Math.min(limit, 1001)).map(row => structuredClone(this.restore(eventFromRow(row))))
  }

  /** Fixed upper sequence and small batches keep history reads from starving live RPC. */
  async listAsync(sessionId: string, afterSeq = '0', limit = 100, signal?: AbortSignal): Promise<DurableEvent[]> {
    signal?.throwIfAborted()
    new SessionOwnership(this.database).assert(sessionId)
    const throughSeq = this.latestSequence(sessionId)
    const events: DurableEvent[] = []
    let cursor = BigInt(afterSeq)
    const count = Math.max(0, Math.min(limit, 1001))
    while (events.length < count && cursor < throughSeq) {
      await yieldToEventLoop(undefined, { signal })
      new SessionOwnership(this.database).assert(sessionId)
      this.reads.synchronize(this.database)
      const statement = this.database.connection.prepare('SELECT * FROM events WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?')
      statement.setReadBigInts(true)
      const rows = statement.all(sessionId, cursor, throughSeq, Math.min(25, count - events.length))
      if (!rows.length) break
      for (const row of rows) events.push(structuredClone(this.restore(eventFromRow(row))))
      cursor = BigInt(events.at(-1)!.seq)
    }
    signal?.throwIfAborted()
    return events
  }

  /** Advance semantic projections over unrelated stream rows without restoring their payloads. */
  projectionBatch(sessionId: string, afterSeq: string, kinds: readonly string[], limit = 100): { events: DurableEvent[]; throughSeq: string } {
    new SessionOwnership(this.database).assert(sessionId)
    this.reads.synchronize(this.database)
    const after = BigInt(afterSeq), upper = this.latestSequence(sessionId)
    const throughSeq = upper > after ? upper : after
    const count = Math.max(1, Math.min(limit, 1001))
    if (!kinds.length || after >= upper) return { events: [], throughSeq: String(throughSeq) }
    const sequences = projectionSequences(this.database, sessionId, after, upper, kinds, count)
    const statement = this.database.connection.prepare('SELECT * FROM events WHERE session_id=? AND seq=?')
    statement.setReadBigInts(true)
    const events = sequences.map(seq => {
      const row = statement.get(sessionId, seq)
      if (!row) throw new Error('Projected event disappeared during reading')
      return structuredClone(this.restore(eventFromRow(row)))
    })
    return { events, throughSeq: events.length === count ? events.at(-1)!.seq : String(throughSeq) }
  }

  latestKindTime(sessionId: string, kinds: readonly string[]): number | undefined {
    new SessionOwnership(this.database).assert(sessionId)
    if (!kinds.length) return undefined
    return latestKindRecord(this.database, sessionId, kinds)?.createdAt
  }

  latestKindSequence(sessionId: string, kinds: readonly string[]): bigint {
    new SessionOwnership(this.database).assert(sessionId)
    return kinds.length ? latestKindRecord(this.database, sessionId, kinds)?.seq ?? 0n : 0n
  }

  latestSequence(sessionId: string): bigint {
    new SessionOwnership(this.database).assert(sessionId)
    const statement = this.database.connection.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id=?')
    statement.setReadBigInts(true)
    return statement.get(sessionId)!.seq as bigint
  }

  /** Restore only the next unseen live event; ranges belong to one authenticated connection. */
  nextPending(ranges: readonly PendingEventRange[]): DurableEvent | undefined {
    if (!ranges.length) return undefined
    const ownership = new SessionOwnership(this.database)
    for (const range of ranges) ownership.assert(range.sessionId)
    this.reads.synchronize(this.database)
    const statement = this.database.connection.prepare(`SELECT * FROM events WHERE rowid=(
      SELECT MIN(candidate.rowid) FROM json_each(?) AS pending
      JOIN events AS candidate ON candidate.session_id=json_extract(pending.value,'$.sessionId')
        AND candidate.seq=CASE
          WHEN CAST(json_extract(pending.value,'$.afterSeq') AS INTEGER)<CAST(json_extract(pending.value,'$.throughSeq') AS INTEGER)
          THEN CAST(json_extract(pending.value,'$.afterSeq') AS INTEGER)+1 END
    )`)
    statement.setReadBigInts(true)
    const row = statement.get(JSON.stringify(ranges))
    return row ? structuredClone(this.restore(eventFromRow(row))) : undefined
  }

  latestContextRequests(sessionId: string): DurableEvent[] {
    new SessionOwnership(this.database).assert(sessionId)
    this.reads.synchronize(this.database)
    return new SessionModelHeads(this.database).requests(sessionId).map(row => {
      const event = structuredClone(this.restore(eventFromRow(row)))
      return { ...event, payload: historicalContextSources(event.payload) }
    })
  }

  latestActorContextEstimate(sessionId: string, actorId?: string | number): JsonValue | undefined {
    new SessionOwnership(this.database).assert(sessionId)
    return new SessionModelHeads(this.database).actorContextEstimate(sessionId, actorId)
  }

  latestUsagePayload(sessionId: string): JsonValue | undefined {
    new SessionOwnership(this.database).assert(sessionId)
    return new SessionModelHeads(this.database).usagePayload(sessionId)
  }

  private restore(event: DurableEvent, depth = 0): DurableEvent {
    if (depth > 129) throw new Error('Persisted message delta chain exceeds snapshot interval')
    const existing = this.reads.get(event.sessionId, event.seq)
    if (existing) return existing
    const payload = restoreStreamPayload(this.requests.restore(event.kind, event.payload), seq => {
      if (!/^[1-9][0-9]*$/.test(seq) || BigInt(seq) >= BigInt(event.seq)) throw new Error('Invalid persisted message delta sequence')
      const statement = this.database.connection.prepare('SELECT * FROM events WHERE session_id=? AND seq=?')
      statement.setReadBigInts(true)
      const row = statement.get(event.sessionId, BigInt(seq))
      if (!row || row.turn_id !== event.turnId) throw new Error('Missing persisted message delta event')
      return this.restore(eventFromRow(row), depth + 1).payload
    })
    const result = { ...event, payload }
    this.reads.set(result)
    return result
  }

  messages(sessionId: string, before: string | undefined, limit: number): { items: DurableEvent[]; hasMore: boolean; nextCursor: string | null } {
    new SessionOwnership(this.database).assert(sessionId)
    let beforeSeq = 9223372036854775807n
    if (before) {
      const cursor = this.database.connection.prepare("SELECT seq FROM events WHERE session_id=? AND id=? AND kind='agent.message_end'")
      cursor.setReadBigInts(true)
      const row = cursor.get(sessionId, before)
      if (!row) throw new Error('Message cursor not found in session')
      beforeSeq = BigInt(row.seq as bigint)
    }
    const statement = this.database.connection.prepare("SELECT * FROM events WHERE session_id=? AND kind='agent.message_end' AND seq<? ORDER BY seq DESC LIMIT ?")
    statement.setReadBigInts(true)
    const rows = statement.all(sessionId, beforeSeq, Math.min(limit, 100) + 1)
    const hasMore = rows.length > limit
    const items = withMessageTurnTiming(this.database, sessionId, rows.slice(0, limit).map(eventFromRow).reverse())
    return { items, hasMore, nextCursor: hasMore ? items[0]!.id : null }
  }
}

function eventFromRow(row: Record<string, SQLOutputValue>): DurableEvent {
  return durableEventSchema.parse({
      id: row.id, sessionId: row.session_id, turnId: row.turn_id, seq: String(row.seq), kind: row.kind,
      payload: jsonValue.parse(JSON.parse(String(row.payload_json))), createdAt: Number(row.created_at),
  })
}
