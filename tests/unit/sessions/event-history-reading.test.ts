import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository, type SessionService } from '../../../src/modules/sessions/index.ts'
import { withAccount, accountKey, type Account } from '../../../src/modules/accounts/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'mon')
  const session = sessions.create('History')
  return { database, sessions, session }
}

test('async history yields to unrelated work and fixes its upper bound before newer writes', async t => {
  const f = fixture(t)
  for (let i = 0; i < 90; i++) f.sessions.events.append(f.session.id, null, 'fixture', { index: i })
  const expected = f.sessions.events.list(f.session.id, '0', 100)
  let yielded = false
  const pending = f.sessions.events.listAsync(f.session.id, '0', 100)
  setImmediate(() => {
    yielded = true
    f.sessions.events.append(f.session.id, null, 'fixture.later', {})
  })
  assert.deepEqual(await pending, expected)
  assert.equal(yielded, true)
  assert.equal(f.sessions.events.list(f.session.id, expected.at(-1)!.seq).length, 1)
})

test('async history rejects aborts before and during reading without publishing events', async t => {
  const f = fixture(t)
  for (let i = 0; i < 80; i++) f.sessions.events.append(f.session.id, null, 'fixture', {})
  let broadcasts = 0
  f.sessions.events.subscribe(() => broadcasts++)
  const controller = new AbortController()
  const pending = f.sessions.events.listAsync(f.session.id, '0', 100, controller.signal)
  setImmediate(() => controller.abort(new Error('connection closed')))
  await assert.rejects(pending, /connection closed|aborted/)
  await assert.rejects(f.sessions.events.listAsync(f.session.id, '0', 100, controller.signal), /connection closed|aborted/)
  assert.equal(broadcasts, 0)
})

test('database closure while yielding fails the read instead of returning a cached page', async () => {
  const database = new EdenDatabase(':memory:', 'mon')
  const sessions = new SessionRepository(database, 'mon'), session = sessions.create('Close')
  const pending = sessions.events.listAsync(session.id)
  database.close()
  await assert.rejects(pending, /not open|closed/)
})

test('event.list forwards its connection lifetime and stops the read when that connection closes', async t => {
  const f = fixture(t)
  for (let i = 0; i < 80; i++) f.sessions.events.append(f.session.id, null, 'fixture', {})
  const controller = new AbortController()
  const original = f.sessions.events.listAsync.bind(f.sessions.events)
  let observedSignal: AbortSignal | undefined
  f.sessions.events.listAsync = (id, after, limit, signal) => {
    observedSignal = signal
    return original(id, after, limit, signal)
  }
  const service = { repository: f.sessions } as SessionService
  const routes = sessionRoutes(service, controller.signal)
  const pending = routes['event.list']!({ sessionId: f.session.id, afterSeq: '0', limit: 100 })
  setImmediate(() => controller.abort(new Error('RPC connection closed')))
  await assert.rejects(Promise.resolve(pending), /closed|aborted/)
  assert.equal(observedSignal, controller.signal)
  assert.deepEqual(await routes.ping!({}), { pong: true })
})

test('projection batches skip malformed unrelated payloads and advance across their sequence range', t => {
  const f = fixture(t)
  const first = f.sessions.events.append(f.session.id, null, 'agent.message_end', { message: { role: 'assistant', content: 'first' } })
  const skipped = f.sessions.events.append(f.session.id, null, 'agent.message_update', {})
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run('invalid JSON', skipped.id)
  const second = f.sessions.events.append(f.session.id, null, 'agent.message_end', { message: { role: 'assistant', content: 'second' } })
  const tail = f.sessions.events.append(f.session.id, null, 'agent.message_update', {})
  const one = f.sessions.events.projectionBatch(f.session.id, '0', ['agent.message_end'], 1)
  assert.deepEqual(one, { events: [first], throughSeq: first.seq })
  const rest = f.sessions.events.projectionBatch(f.session.id, one.throughSeq, ['agent.message_end'], 10)
  assert.deepEqual(rest, { events: [second], throughSeq: tail.seq })
  assert.deepEqual(f.sessions.events.projectionBatch(f.session.id, tail.seq, ['agent.message_end']), { events: [], throughSeq: tail.seq })
  assert.deepEqual(f.sessions.events.projectionBatch(f.session.id, '99', []), { events: [], throughSeq: '99' })
})

test('projection payloads restore compact requests and reject corrupt selected data', t => {
  const f = fixture(t)
  const event = f.sessions.events.append(f.session.id, null, 'model.request', { payload: { prompt: 'x'.repeat(1000) } })
  assert.deepEqual(f.sessions.events.projectionBatch(f.session.id, '0', ['model.request']).events, [event])
  f.database.connection.prepare('DELETE FROM request_contents').run()
  assert.throws(() => f.sessions.events.projectionBatch(f.session.id, '0', ['model.request']), /Missing or corrupt request content/)
})

test('latest semantic time follows sequence order and ignores stream updates', t => {
  const f = fixture(t)
  const old = f.sessions.events.append(f.session.id, null, 'session.title_updated', {})
  const latest = f.sessions.events.append(f.session.id, null, 'agent.message_end', {})
  f.sessions.events.append(f.session.id, null, 'agent.message_update', {})
  f.database.connection.prepare('UPDATE events SET created_at=? WHERE id=?').run(200, old.id)
  f.database.connection.prepare('UPDATE events SET created_at=? WHERE id=?').run(100, latest.id)
  assert.equal(f.sessions.events.latestKindTime(f.session.id, ['session.title_updated', 'agent.message_end']), 100)
  assert.equal(f.sessions.events.latestKindTime(f.session.id, ['absent']), undefined)
  assert.equal(f.sessions.events.latestKindTime(f.session.id, []), undefined)
})

test('async and semantic history APIs cannot bypass session ownership', async t => {
  const f = fixture(t)
  const account = (userId: string): Account => ({ userId, coreBaseUrl: 'http://fixture.invalid', key: accountKey('http://fixture.invalid', userId) })
  const owner = account('owner'), stranger = account('stranger')
  const session = withAccount(owner, () => f.sessions.create('Private'))
  await assert.rejects(withAccount(stranger, () => f.sessions.events.listAsync(session.id)), /不属于当前账号/)
  assert.throws(() => withAccount(stranger, () => f.sessions.events.projectionBatch(session.id, '0', [])), /不属于当前账号/)
  assert.throws(() => withAccount(stranger, () => f.sessions.events.latestKindTime(session.id, [])), /不属于当前账号/)
  assert.throws(() => withAccount(stranger, () => f.sessions.events.latestSequence(session.id)), /不属于当前账号/)
  assert.throws(() => withAccount(stranger, () => f.sessions.events.latestKindSequence(session.id, [])), /不属于当前账号/)
})
