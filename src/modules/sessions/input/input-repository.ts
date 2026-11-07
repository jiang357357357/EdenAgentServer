import { randomUUID } from 'node:crypto'
import { jsonValue } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { SessionInput, AcceptedInput } from '../contracts.ts'
import { SessionEvents } from '../session-events.ts'
import { sessionStorage } from '../session-storage.ts'
import { inputCompletion } from './input-completion.ts'

export class InputRepository {
  constructor(private readonly database: EdenDatabase, private readonly events: SessionEvents) {}

  pendingSessions(): string[] {
    return this.database.connection.prepare("SELECT DISTINCT session_id FROM inputs WHERE state='queued'").all().map(row => String(row.session_id))
  }

  interruptedSessions(): string[] {
    return this.database.connection.prepare("SELECT DISTINCT session_id FROM inputs WHERE state='running'").all().map(row => String(row.session_id))
  }

  hasPending(sessionId: string): boolean {
    return Boolean(this.database.connection.prepare("SELECT 1 FROM inputs WHERE session_id=? AND state='queued' LIMIT 1").get(sessionId))
  }

  cancelInput(sessionId: string, inputId: string): string | undefined {
    const result = this.database.transaction(() => {
      const row = this.database.connection.prepare("SELECT turn_id FROM inputs WHERE session_id=? AND id=? AND state IN ('queued','running')").get(sessionId, inputId)
      if (!row) return undefined
      this.database.connection.prepare("UPDATE inputs SET state='cancelled' WHERE id=?").run(inputId)
      return { turn: String(row.turn_id), event: this.events.insert(sessionId, String(row.turn_id), 'input.cancelled', { inputId, reason: 'Cancelled by sender' }) }
    })
    if (result) this.events.publish(result.event)
    return result?.turn
  }

  cancelQueued(sessionId: string): number {
    const events = this.database.transaction(() => {
      const rows = this.database.connection.prepare("SELECT id,turn_id FROM inputs WHERE session_id=? AND state='queued'").all(sessionId)
      if (!rows.length) return []
      this.database.connection.prepare("UPDATE inputs SET state='cancelled' WHERE session_id=? AND state='queued'").run(sessionId)
      return rows.map(row => this.events.insert(sessionId, String(row.turn_id), 'input.cancelled', {
        inputId: String(row.id), reason: 'Session stopped by user',
      }))
    })
    for (const event of events) this.events.publish(event)
    return events.length
  }

  enqueue(sessionId: string, text: string, idempotencyKey: string, metadata: JsonValue = {}, kind: 'prompt' | 'compact' = 'prompt', environmentUpdate?: JsonValue, onCommit?: (input: AcceptedInput) => void): AcceptedInput {
    const result = this.database.transaction(() => {
      const old = this.database.connection.prepare('SELECT * FROM inputs WHERE session_id=? AND idempotency_key=?').get(sessionId, idempotencyKey)
      if (old) {
        if (old.text !== text || old.metadata_json !== JSON.stringify(metadata) || old.kind !== kind) throw new Error('Idempotency key already used for a different input')
        const accepted = { sessionId, turnId: String(old.turn_id), inputId: String(old.id), state: String(old.state) }
        onCommit?.(accepted)
        return { accepted }
      }
      const id = randomUUID()
      const turnId = randomUUID()
      this.database.connection.prepare('INSERT INTO inputs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, turnId, idempotencyKey, text, 'queued', Date.now(), JSON.stringify(metadata), kind)
      onCommit?.({ sessionId, turnId, inputId: id, state: 'queued' })
      const environmentEvent = environmentUpdate === undefined ? undefined : this.events.insert(sessionId, turnId, 'session.metadata.updated', environmentUpdate)
      const changedEvent = environmentUpdate === undefined ? undefined : this.events.insert(sessionId, turnId, 'session.environment_updated', environmentUpdate)
      return {
        environmentEvent, changedEvent,
        accepted: { sessionId, turnId, inputId: id, state: 'queued' },
        event: this.events.insert(sessionId, turnId, 'input.queued', { text, inputId: id, kind, metadata }),
      }
    })
    if (result.environmentEvent) this.events.publish(result.environmentEvent)
    if (result.changedEvent) this.events.publish(result.changedEvent)
    if (result.event) this.events.publish(result.event)
    return result.accepted
  }

  claim(sessionId: string): SessionInput | undefined {
    const result = sessionStorage('待执行输入读取失败', () => this.database.transaction(() => {
      const row = this.database.connection.prepare("SELECT * FROM inputs WHERE session_id=? AND state='queued' ORDER BY created_at, rowid LIMIT 1").get(sessionId)
      if (!row) return undefined
      const input: SessionInput = { id: String(row.id), sessionId, turnId: String(row.turn_id), text: String(row.text), state: 'running',
        metadata: jsonValue.parse(JSON.parse(String(row.metadata_json))), kind: row.kind === 'compact' ? 'compact' : 'prompt' }
      const now = Date.now()
      this.database.connection.prepare("UPDATE inputs SET state='running' WHERE id=?").run(input.id)
      this.database.connection.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)').run(input.turnId, sessionId, 'running', null, now, now)
      return { input, event: this.events.insert(sessionId, input.turnId, 'turn.started', { inputId: input.id }) }
    }))
    if (result) this.events.publish(result.event)
    return result?.input
  }

  finish(input: SessionInput, error?: string, cancelledByUser = false): void {
    const cancelled = this.database.connection.prepare('SELECT state FROM inputs WHERE id=?').get(input.id)?.state === 'cancelled'
    const completion = inputCompletion(error, cancelled, cancelledByUser)
    const events = sessionStorage('会话结束状态提交失败', () => this.database.transaction(() => {
      this.database.connection.prepare('UPDATE inputs SET state=? WHERE id=?').run(completion.state, input.id)
      this.database.connection.prepare('UPDATE turns SET state=?, error=?, updated_at=? WHERE id=?').run(completion.state, completion.error, Date.now(), input.turnId)
      this.database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), input.sessionId)
      const timing = completion.completed ? this.completedTiming(input) : {}
      const shared = this.database.connection.prepare('SELECT 1 FROM qq_shared_rooms WHERE session_id=?').get(input.sessionId)
      const reason = completion.reason
      const recovery = reason ? [...this.interruptOperations(input, reason), ...(shared ? [] : this.holdQueuedEvents(input.sessionId, reason))] : []
      const event = this.events.insert(input.sessionId, input.turnId, completion.event, {
        inputId: input.id, reason: reason ?? null, ...timing,
      })
      return [...recovery, event]
    }))
    for (const event of events) this.events.publish(event)
  }

  holdQueued(sessionId: string, reason: string): void {
    const events = sessionStorage('待执行输入暂停失败', () => this.database.transaction(() => this.holdQueuedEvents(sessionId, reason)))
    for (const event of events) this.events.publish(event)
  }

  private completedTiming(input: SessionInput): { turnTiming?: { startedAt: number } } {
    const boundary = this.database.connection.prepare(`SELECT created_at FROM events INDEXED BY events_session_turn_kind_seq
      WHERE session_id=? AND turn_id=? AND kind='turn.started' ORDER BY seq LIMIT 1`)
    boundary.setReadBigInts(true)
    const row = boundary.get(input.sessionId, input.turnId)
    const timestamp = row ? Number(row.created_at) : NaN
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? { turnTiming: { startedAt: timestamp } } : {}
  }

  private holdQueuedEvents(sessionId: string, reason: string) {
    const rows = this.database.connection.prepare("SELECT id,turn_id FROM inputs WHERE session_id=? AND state='queued'").all(sessionId)
    this.database.connection.prepare("UPDATE inputs SET state='held' WHERE session_id=? AND state='queued'").run(sessionId)
    return rows.map(row => this.events.insert(sessionId, String(row.turn_id), 'input.held', { inputId: String(row.id), reason }))
  }

  private interruptOperations(input: SessionInput, reason: string) {
    const rows = this.database.connection.prepare("SELECT id FROM tool_operations WHERE session_id=? AND turn_id=? AND state='running'")
      .all(input.sessionId, input.turnId)
    this.database.connection.prepare("UPDATE tool_operations SET state='unknown',error_json=?,updated_at=? WHERE session_id=? AND turn_id=? AND state='running'")
      .run(JSON.stringify({ error: reason }), Date.now(), input.sessionId, input.turnId)
    return rows.map(row => this.events.insert(input.sessionId, input.turnId, 'operation.completed', {
      callId: String(row.id).slice(input.turnId.length + 1), result: { error: reason }, failed: true, outcome: 'unknown',
    }))
  }

  running(sessionId: string): SessionInput[] {
    return this.database.connection.prepare("SELECT id,turn_id,text FROM inputs WHERE session_id=? AND state='running'").all(sessionId)
      .map(row => ({ id: String(row.id), sessionId, turnId: String(row.turn_id), text: String(row.text), state: 'running' }))
  }

  recoverInterrupted(): number {
    const rows = this.database.connection.prepare("SELECT * FROM inputs WHERE state='running'").all()
    for (const row of rows) {
      // Future queued inputs need explicit resubmission after an uncertain turn; repeated restarts cannot release them.
      this.database.connection.prepare(`UPDATE inputs SET state='held' WHERE session_id=? AND state='queued'
        AND NOT EXISTS(SELECT 1 FROM qq_shared_rooms r WHERE r.session_id=inputs.session_id)`).run(row.session_id!)
      this.finish({ id: String(row.id), sessionId: String(row.session_id), turnId: String(row.turn_id), text: String(row.text), state: 'running' }, 'Server restarted during execution')
    }
    // A restart must not execute user input that had not begun before shutdown.
    // Job inputs retain their own scheduler and recovery policy.
    this.database.connection.prepare(`UPDATE inputs SET state='held' WHERE state='queued' AND COALESCE(json_type(metadata_json,'$.job'),'')!='object'
      AND NOT EXISTS(SELECT 1 FROM qq_shared_rooms r WHERE r.session_id=inputs.session_id)`).run()
    this.database.connection.prepare("UPDATE tool_operations SET state='unknown', updated_at=? WHERE state='running'").run(Date.now())
    return rows.length
  }
}
