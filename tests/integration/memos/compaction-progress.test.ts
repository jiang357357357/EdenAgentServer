import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { qqTurnStatus } from '../../../src/modules/qq-channel/reply-status.ts'

test('QQ status exposes saved compaction progress only for the matching session and turn', () => {
  const database = new EdenDatabase(':memory:', 'mon')
  try {
    const sessions = new SessionRepository(database, 'mon')
    const session = sessions.create('Compacting history'), unrelated = sessions.create('Unrelated chat')
    const turnId = randomUUID()
    sessions.events.append(session.id, turnId, 'agent.compaction_progress', { processed: 33, total: 40, resumed: true })
    const result = qqTurnStatus(database, session.id, turnId, { state: 'running' }, '0') as { updates: Record<string, unknown>[]; next_seq: string }
    assert.equal(result.updates.length, 1)
    assert.deepEqual({ ...result.updates[0], seq: undefined }, { seq: undefined, kind: 'compaction', processed: 33, total: 40, resumed: true })
    const other = qqTurnStatus(database, unrelated.id, turnId, { state: 'running' }, '0') as { updates: unknown[] }
    assert.deepEqual(other.updates, [])
    sessions.events.append(session.id, turnId, 'agent.compaction_progress', { processed: 41, total: 40 })
    const invalid = qqTurnStatus(database, session.id, turnId, { state: 'running' }, result.next_seq) as { updates: unknown[] }
    assert.deepEqual(invalid.updates, [])
  } finally { database.close() }
})
