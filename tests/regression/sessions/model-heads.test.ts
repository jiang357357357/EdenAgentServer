import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { runtimeCallbacks } from '../../../src/modules/sessions/turn/runtime-callbacks.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'mon'), session = sessions.create('Model heads')
  const raw = (seq: bigint, kind: string, payload: JsonValue, sessionId = session.id) => {
    const id = randomUUID()
    database.connection.prepare('INSERT INTO events VALUES(?,?,NULL,?,?,?,0)').run(id, sessionId, seq, kind, JSON.stringify(payload))
    return id
  }
  return { database, sessions, session, raw }
}

test('latest 32 actors preserve grouping, exact BigInt order and restored content-addressed snapshots', t => {
  const f = fixture(t), events = f.sessions.events
  const first = 9_007_199_254_740_992n
  f.raw(first, 'model.request', { actor: { assistantID: 1 }, contextEstimate: { epoch: 1 } })
  const replacement = events.append(f.session.id, null, 'model.request', { actor: { assistantID: '1' }, contextEstimate: { epoch: 2 } })
  assert.equal(replacement.seq, String(first + 1n))
  assert.equal(events.latestContextRequests(f.session.id).length, 1)
  assert.deepEqual(events.latestActorContextEstimate(f.session.id, 1), { epoch: 2 })
  events.append(f.session.id, null, 'model.request', { contextEstimate: { epoch: 'local' } })
  events.append(f.session.id, null, 'model.request', { actor: { assistantID: null }, contextEstimate: { epoch: 'no actor' } })
  assert.equal(events.latestContextRequests(f.session.id).length, 2)
  assert.deepEqual(events.latestActorContextEstimate(f.session.id), { epoch: 'no actor' })
  const expected = []
  for (let actor = 0; actor < 40; actor++) {
    expected.push(events.append(f.session.id, null, 'model.request', {
      actor: { assistantID: `actor-${actor}` }, requestId: `request-${actor}`,
      contextEstimate: { epoch: actor }, payload: { messages: [{ role: 'system', content: '正文'.repeat(400) }] },
    }))
  }
  events.append(f.session.id, null, 'director.model.request', { actor: { assistantID: 'director' } })
  events.append(f.session.id, null, 'memory.extraction.model_request', { snapshot: { actor: { assistantID: 'memory' } } })
  const restored = new SessionRepository(f.database, 'mon').events.latestContextRequests(f.session.id)
  assert.deepEqual(restored, expected.slice(-32).reverse())
  restored[0]!.payload = { changed: true }
  assert.deepEqual(events.latestContextRequests(f.session.id), expected.slice(-32).reverse())
})

test('request context survives callback recreation per actor without scanning earlier request events', async t => {
  const f = fixture(t)
  const input = { id: randomUUID(), sessionId: f.session.id, turnId: randomUUID(), state: 'running', text: 'hello' }
  const snapshot = (model: string) => ({ requestId: randomUUID(), model, provider: 'fixture',
    payload: { messages: [{ role: 'system', content: 'stable'.repeat(500) }] } })
  const callback = (actor: string) => runtimeCallbacks(f.sessions, input, { actor: { assistantID: actor } })
  await callback('alice').request(snapshot('first'))
  await callback('bob').request(snapshot('second'))
  await callback('alice').request(snapshot('first'))
  const estimate = (actor: string) => f.sessions.events.latestActorContextEstimate(f.session.id, actor) as Record<string, JsonValue>
  assert.equal(estimate('alice').promptCacheEpoch, 1)
  assert.equal(estimate('alice').promptCacheInvalidationReason, 'stable')
  assert.equal(estimate('bob').promptCacheInvalidationReason, 'initial')
  const queries: string[] = [], prepare = f.database.connection.prepare.bind(f.database.connection)
  t.mock.method(f.database.connection, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql) })
  await callback('alice').request(snapshot('changed'))
  assert.equal(estimate('alice').promptCacheEpoch, 2)
  assert.ok(queries.some(sql => sql.includes('FROM session_model_request_heads AS h')))
  assert.ok(queries.every(sql => !/FROM events\s+WHERE session_id=\? AND kind='model.request'/u.test(sql)))
  queries.length = 0
  estimate('alice')
  assert.equal(queries.filter(sql => /FROM request_contents/u.test(sql)).length, 0, 'Previous estimates stay inline; old request content is not restored')
})

test('head changes share the event transaction and out-of-order imports cannot replace newer heads', t => {
  const f = fixture(t)
  f.raw(50n, 'model.request', { actor: { assistantID: 'actor' }, contextEstimate: { epoch: 50 } })
  f.raw(40n, 'model.request', { actor: { assistantID: 'actor' }, contextEstimate: { epoch: 40 } })
  f.raw(45n, 'model.response', { usage: { input: 40, output: 5 } })
  f.raw(30n, 'model.response', { usage: { input: 20, output: 10 } })
  assert.deepEqual(f.sessions.events.latestActorContextEstimate(f.session.id, 'actor'), { epoch: 50 })
  assert.equal(f.sessions.read(f.session.id).contextTokens, 45)
  let published = 0
  f.sessions.events.subscribe(() => published++)
  assert.throws(() => f.database.transaction(() => {
    f.sessions.events.insert(f.session.id, null, 'model.request', { actor: { assistantID: 'actor' }, contextEstimate: { epoch: 60 } })
    f.sessions.events.insert(f.session.id, null, 'model.response', { usage: { input: 60, output: 6 } })
    assert.equal(f.sessions.read(f.session.id).contextTokens, 66)
    throw new Error('Rollback fixture')
  }), /Rollback fixture/)
  assert.equal(published, 0)
  assert.deepEqual(f.sessions.events.latestActorContextEstimate(f.session.id, 'actor'), { epoch: 50 })
  assert.equal(f.sessions.read(f.session.id).contextTokens, 45)
  f.database.connection.exec("CREATE TRIGGER fail_model AFTER INSERT ON events WHEN NEW.kind='model.request' BEGIN SELECT RAISE(ABORT,'disk failure'); END")
  assert.throws(() => f.sessions.events.append(f.session.id, null, 'model.request', { actor: { assistantID: 'failed' } }), /disk failure/)
  assert.equal(f.sessions.events.latestActorContextEstimate(f.session.id, 'failed'), undefined)
})

test('latest valid usage ignores failures, strings, negative and absent counts without accumulating', t => {
  const f = fixture(t)
  const events = f.sessions.events
  const valid = { usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 5 }, contextEstimate: { history: 25 } }
  events.append(f.session.id, null, 'model.response', valid)
  for (const payload of [{ usage: null }, { usage: { input: '999', output: 10 } }, { usage: { input: -1, output: 1 } },
    { usage: { input: 1 } }, { usage: { input: true, output: 1 } }, { usage: { input: 1, output: -1 } }]) {
    events.append(f.session.id, null, 'model.response', payload)
  }
  assert.deepEqual(events.latestUsagePayload(f.session.id), valid)
  assert.equal(f.sessions.read(f.session.id).contextTokens, 50)
  events.append(f.session.id, null, 'model.response', { usage: { input: 0, output: 0 } })
  assert.equal(f.sessions.read(f.session.id).contextTokens, 0)
  f.database.connection.prepare('INSERT INTO events VALUES(?,?,NULL,?,?,?,0)')
    .run(randomUUID(), f.session.id, 100n, 'model.response', '{"usage":{"input":9e999,"output":0}}')
  assert.equal(f.sessions.read(f.session.id).contextTokens, undefined, 'Legacy non-finite counts remain rejected by modelContextUsage')
})

test('explicit model edits and deletion rebuild actor, session and usage heads', t => {
  const f = fixture(t), other = f.sessions.create('Other')
  const prior = f.raw(10n, 'model.request', { actor: { assistantID: 'actor' }, contextEstimate: { old: true } })
  const latest = f.raw(20n, 'model.request', { actor: { assistantID: 'actor' }, contextEstimate: { newest: true } })
  f.database.connection.prepare('UPDATE events SET session_id=?,seq=?,payload_json=? WHERE id=?')
    .run(other.id, 30n, JSON.stringify({ actor: { assistantID: 'moved' }, contextEstimate: { moved: true } }), latest)
  assert.deepEqual(f.sessions.events.latestActorContextEstimate(f.session.id, 'actor'), { old: true })
  assert.equal(f.sessions.events.latestActorContextEstimate(other.id, 'actor'), undefined)
  assert.deepEqual(f.sessions.events.latestActorContextEstimate(other.id, 'moved'), { moved: true })
  f.database.connection.prepare('UPDATE events SET kind=?,payload_json=? WHERE id=?')
    .run('model.response', JSON.stringify({ usage: { input: 8, output: 2 } }), latest)
  assert.equal(f.sessions.events.latestContextRequests(other.id).length, 0)
  assert.equal(f.sessions.read(other.id).contextTokens, 10)
  f.database.connection.prepare('DELETE FROM events WHERE id IN (?,?)').run(prior, latest)
  assert.equal(f.sessions.events.latestContextRequests(f.session.id).length, 0)
  assert.equal(f.sessions.read(other.id).contextTokens, undefined)
})

test('malformed model JSON fails only affected reads and explicit repair or deletion recovers', t => {
  const f = fixture(t), healthy = f.sessions.create('Healthy')
  const request = f.raw(10n, 'model.request', { contextEstimate: { healthy: true } })
  const response = f.raw(20n, 'model.response', { usage: { input: 1, output: 2 } })
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id IN (?,?)').run('not JSON', request, response)
  assert.throws(() => f.sessions.events.latestContextRequests(f.session.id), /Malformed persisted model request JSON/)
  assert.throws(() => f.sessions.events.latestActorContextEstimate(f.session.id), /Malformed persisted model request JSON/)
  assert.throws(() => f.sessions.events.latestUsagePayload(f.session.id), SyntaxError)
  assert.deepEqual(f.sessions.events.latestContextRequests(healthy.id), [])
  assert.equal(f.sessions.events.latestUsagePayload(healthy.id), undefined)
  f.database.connection.prepare('INSERT INTO events VALUES(?,?,NULL,?,?,?,0)')
    .run(randomUUID(), f.session.id, 21n, 'agent.message_update', 'also not JSON')
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?')
    .run(JSON.stringify({ contextEstimate: { repaired: true } }), request)
  assert.deepEqual(f.sessions.events.latestActorContextEstimate(f.session.id), { repaired: true })
  assert.equal(f.sessions.events.latestContextRequests(f.session.id).length, 1)
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?')
    .run(JSON.stringify({ usage: { input: 1, output: 2 } }), response)
  assert.equal(f.sessions.read(f.session.id).contextTokens, 3)
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run('broken again', response)
  assert.throws(() => f.sessions.events.latestUsagePayload(f.session.id), SyntaxError)
  f.database.connection.prepare('DELETE FROM events WHERE id=?').run(response)
  assert.equal(f.sessions.events.latestUsagePayload(f.session.id), undefined)
  const broken = f.raw(30n, 'model.request', {})
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run('broken', broken)
  f.database.connection.prepare('DELETE FROM events WHERE id=?').run(broken)
  assert.equal(f.sessions.events.latestContextRequests(f.session.id).length, 1)
})

test('model head APIs enforce ownership before examining or returning private event data', t => {
  const f = fixture(t)
  const account = (userId: string) => ({ userId, coreBaseUrl: 'http://fixture.invalid', key: accountKey('http://fixture.invalid', userId) })
  const owner = account('owner'), stranger = account('stranger')
  const session = withAccount(owner, () => f.sessions.create('Private'))
  f.raw(5n, 'model.request', { contextEstimate: { private: true } }, session.id)
  f.raw(6n, 'model.response', { usage: { input: 1, output: 2 } }, session.id)
  const reads = [() => f.sessions.events.latestContextRequests(session.id),
    () => f.sessions.events.latestActorContextEstimate(session.id), () => f.sessions.events.latestUsagePayload(session.id)]
  for (const read of reads) {
    assert.doesNotThrow(() => withAccount(owner, read))
    assert.throws(() => withAccount(stranger, read), /不属于当前账号/)
  }
})
