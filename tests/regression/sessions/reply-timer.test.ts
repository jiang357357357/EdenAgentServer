import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { replyTimerSnapshotSchema } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'
import type { SessionService } from '../../../src/modules/sessions/index.ts'

function fixture(t: TestContext, origin: 'mon' | 'local' = 'local') {
  const database = new EdenDatabase(':memory:', origin)
  t.after(() => database.close())
  const sessions = new SessionRepository(database, origin), session = sessions.create('Reply timer')
  const inputs = new InputRepository(database, sessions.events)
  let now = 100
  t.mock.method(Date, 'now', () => now)
  return { database, sessions, session, inputs, at: (value: number) => { now = value } }
}

test('timer starts on execution, survives repository recreation, freezes on completion and resets for the next turn', t => {
  const f = fixture(t)
  assert.equal(f.sessions.replyTimer(f.session.id).turn, null)
  f.inputs.enqueue(f.session.id, 'First answer', 'first')
  f.at(900)
  assert.equal(f.sessions.replyTimer(f.session.id).turn, null, 'Queue waiting is not answering')
  f.at(1000)
  const input = f.inputs.claim(f.session.id)!
  f.at(7500)
  const running = new SessionRepository(f.database, 'local').replyTimer(f.session.id)
  assert.deepEqual(running.turn, { turnId: input.turnId, startedAt: 1000, outcome: 'running' })
  assert.equal(running.observedAt, 7500)
  assert.deepEqual(replyTimerSnapshotSchema.parse(running), running)
  f.at(9000); f.inputs.finish(input)
  f.at(20000)
  assert.deepEqual(f.sessions.replyTimer(f.session.id).turn, { turnId: input.turnId, startedAt: 1000, finishedAt: 9000, outcome: 'completed' })
  f.inputs.enqueue(f.session.id, 'Next answer', 'next')
  assert.equal(f.sessions.replyTimer(f.session.id).turn?.turnId, input.turnId)
  f.at(22000)
  const next = f.inputs.claim(f.session.id)!
  assert.deepEqual(f.sessions.replyTimer(f.session.id).turn, { turnId: next.turnId, startedAt: 22000, outcome: 'running' })
})

test('stopping and recovery record elapsed time without treating partial answers as successful replies', t => {
  const f = fixture(t)
  for (const recovered of [false, true]) {
    f.at(1000); f.inputs.enqueue(f.session.id, 'Interrupted answer', String(recovered))
    const input = f.inputs.claim(f.session.id)!
    f.at(4500)
    if (recovered) f.inputs.recoverInterrupted(); else f.inputs.finish(input, 'Cancelled by user')
    assert.deepEqual(f.sessions.replyTimer(f.session.id).turn, { turnId: input.turnId, startedAt: 1000, finishedAt: 4500, outcome: 'interrupted' })
  }
})

test('reads use bounded indexed boundaries, ignore stream bodies and use exact event time rather than turn table time', t => {
  const f = fixture(t)
  f.at(1000); f.inputs.enqueue(f.session.id, 'Slow tool', 'tool')
  const input = f.inputs.claim(f.session.id)!
  f.database.connection.prepare('UPDATE turns SET created_at=999 WHERE id=?').run(input.turnId)
  f.database.connection.prepare(`WITH RECURSIVE stream(n) AS (SELECT 10 UNION ALL SELECT n+1 FROM stream WHERE n<10009)
    INSERT INTO events SELECT 'timer-stream-'||n,?,?,n,'agent.message_update','not JSON',n FROM stream`).run(f.session.id, input.turnId)
  f.at(20000); f.inputs.finish(input)
  const original = f.database.connection.prepare.bind(f.database.connection), queries: string[] = []
  t.mock.method(f.database.connection, 'prepare', (sql: string) => { queries.push(sql); return original(sql) })
  const timer = f.sessions.replyTimer(f.session.id)
  assert.equal(timer.turn?.startedAt, 1000)
  assert.equal(timer.turn?.finishedAt, 20000)
  assert.ok(queries.every(sql => !/SELECT \*|agent\.message_update|FROM turns/.test(sql)))
  const start = queries.find(sql => sql.includes("kind='turn.started'"))!
  const end = queries.find(sql => sql.includes('kind=? AND seq>?'))!
  for (const [sql, params] of [[start, [f.session.id]], [end, [f.session.id, input.turnId, 'turn.completed', 1]]] as const) {
    const plan = original(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    assert.ok(plan.every(row => !/SCAN events|USE TEMP B-TREE/.test(String(row.detail))))
    assert.ok(plan.some(row => /SEARCH events USING INDEX events_session/.test(String(row.detail))))
  }
})

test('failed turns stop, invalid boundaries are not rendered and another session cannot supply an ending', t => {
  const f = fixture(t), other = f.sessions.create('Other session')
  f.at(1000); f.inputs.enqueue(f.session.id, 'Failed request', 'failed')
  const input = f.inputs.claim(f.session.id)!
  f.at(2000); f.sessions.events.append(other.id, input.turnId, 'turn.completed', {})
  assert.equal(f.sessions.replyTimer(f.session.id).turn?.outcome, 'running')
  f.at(3000); f.sessions.events.append(f.session.id, input.turnId, 'turn.failed', { reason: 'Failure' })
  assert.equal(f.sessions.replyTimer(f.session.id).turn?.finishedAt, 3000)
  assert.equal(f.sessions.replyTimer(f.session.id).turn?.outcome, 'failed')
  f.database.connection.prepare("UPDATE events SET created_at=500 WHERE session_id=? AND kind='turn.failed'").run(f.session.id)
  assert.equal(f.sessions.replyTimer(f.session.id).turn, null)
})

test('the typed read RPC enforces account, origin, deleted-session and UUID boundaries', async t => {
  const f = fixture(t, 'mon')
  const account = (userId: string) => ({ userId, coreBaseUrl: 'http://fixture.invalid', key: accountKey('http://fixture.invalid', userId) })
  const owner = account('owner'), other = account('other')
  const session = withAccount(owner, () => f.sessions.create('Private timer'))
  const service = { repository: f.sessions } as SessionService
  const read = sessionRoutes(service)['session.timing.read']!
  assert.deepEqual(await withAccount(owner, () => read({ sessionId: session.id })), f.sessions.replyTimer(session.id))
  await assert.rejects(async () => withAccount(other, () => read({ sessionId: session.id })), /不属于当前账号/)
  assert.throws(() => new SessionRepository(f.database, 'local').replyTimer(session.id), /Session not found/)
  await assert.rejects(async () => read({ sessionId: 'bad-id' }))
  await assert.rejects(async () => read({ sessionId: randomUUID() }), /Session not found/)
  f.database.connection.prepare("UPDATE sessions SET status='deleted' WHERE id=?").run(session.id)
  await assert.rejects(async () => withAccount(owner, () => read({ sessionId: session.id })), /Session not found/)
})
