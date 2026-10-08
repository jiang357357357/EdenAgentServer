import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { replyTimerSnapshotSchema } from '@eden/api'

function fixture(t: TestContext) {
  const db = new EdenDatabase(':memory:', 'local'), sessions = new SessionRepository(db, 'local')
  const session = sessions.create('Timing breakdown'), inputs = new InputRepository(db, sessions.events)
  t.after(() => db.close())
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  inputs.enqueue(session.id, 'First', 'first')
  const input = inputs.claim(session.id)!
  return { db, sessions, session, inputs, input, at: (value: number) => { now = value },
    event: (kind: string, payload: Record<string, string> = {}) => sessions.events.append(session.id, input.turnId, kind, payload),
    read: () => sessions.replyTimer(session.id) }
}

test('durable request/tool pairs restore exact phase wall time and current turn total resets for the next turn', t => {
  const f = fixture(t)
  f.at(2000); f.event('model.request', { requestId: 'first' })
  f.at(6000); f.event('model.response', { requestId: 'first' })
  f.at(7000); f.event('operation.started', { callId: 'tool' })
  f.at(10000); f.event('operation.completed', { callId: 'tool' })
  f.at(11000); f.event('model.request', { requestId: 'second' })
  f.at(14000); f.event('model.response', { requestId: 'second' })
  f.at(15000); f.inputs.finish(f.input)
  f.at(99000)
  const timer = f.read()
  assert.deepEqual(timer.breakdown, { thinking: { elapsedMs: 7000, activeIds: [] },
    tools: { elapsedMs: 3000, activeIds: [] }, turnElapsedMs: 14000 })
  assert.deepEqual(replyTimerSnapshotSchema.parse(timer), timer)
  f.inputs.enqueue(f.session.id, 'Next', 'next')
  f.at(110000); const next = f.inputs.claim(f.session.id)!
  f.at(115000)
  const restored = new SessionRepository(f.db, 'local').replyTimer(f.session.id)
  assert.equal(restored.turn?.turnId, next.turnId)
  assert.equal(restored.breakdown?.turnElapsedMs, 5000)
  assert.deepEqual(restored.breakdown?.thinking, { elapsedMs: 0, activeIds: [] })
})

test('parallel tools merge intervals, a duplicate start or unknown completion does not inflate elapsed time', t => {
  const f = fixture(t)
  for (const [time, kind, id] of [[2000, 'operation.started', 'a'], [3000, 'operation.started', 'b'],
    [4000, 'operation.completed', 'unknown'], [5000, 'operation.started', 'a'],
    [6000, 'operation.completed', 'a'], [8000, 'operation.completed', 'b']] as const) {
    f.at(time); f.event(kind, { callId: id })
  }
  assert.deepEqual(f.read().breakdown?.tools, { elapsedMs: 6000, activeIds: [] })
})

test('interruption and failure close active model/tool spans at the persisted boundary and remain frozen', t => {
  for (const outcome of ['interrupted', 'failed']) {
    const f = fixture(t)
    f.at(2000); f.event('model.request', { requestId: 'request' })
    f.at(3000); f.event('operation.started', { callId: 'tool' })
    f.at(6000)
    if (outcome === 'interrupted') f.inputs.finish(f.input, 'Stopped')
    else f.event('turn.failed')
    f.at(999000)
    assert.deepEqual(f.read().breakdown, { thinking: { elapsedMs: 4000, activeIds: [] },
      tools: { elapsedMs: 3000, activeIds: [] }, turnElapsedMs: 5000 })
  }
})

test('phase queries use session/turn/kind indexes and never restore stream bodies or another session', t => {
  const f = fixture(t), other = f.sessions.create('Other')
  f.at(2000); f.event('model.request', { requestId: 'request' })
  f.sessions.events.append(other.id, f.input.turnId, 'model.response', { requestId: 'request' })
  f.db.connection.prepare(`WITH RECURSIVE stream(n) AS (SELECT 10 UNION ALL SELECT n+1 FROM stream WHERE n<10009)
    INSERT INTO events SELECT 'phase-stream-'||n,?,?,n,'agent.message_update','not JSON',n FROM stream`).run(f.session.id, f.input.turnId)
  const original = f.db.connection.prepare.bind(f.db.connection), queries: string[] = []
  t.mock.method(f.db.connection, 'prepare', (sql: string) => { queries.push(sql); return original(sql) })
  f.at(5000)
  assert.deepEqual(f.read().breakdown?.thinking, { elapsedMs: 0, activeSince: 2000, activeIds: ['request'] })
  assert.ok(queries.every(sql => !/SELECT \*|agent\.message_update|FROM turns/.test(sql)))
  for (const sql of queries.filter(sql => sql.includes('AS id'))) {
    const plan = original('EXPLAIN QUERY PLAN ' + sql).all(f.session.id, f.input.turnId, 'model.request')
    assert.ok(plan.some(row => /SEARCH events USING INDEX events_session_turn_kind_seq/.test(String(row.detail))))
    assert.ok(plan.every(row => !/SCAN events|USE TEMP B-TREE/.test(String(row.detail))))
  }
})
