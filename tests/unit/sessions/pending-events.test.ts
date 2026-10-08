import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import type { DurableEvent } from '@eden/api'
import { SessionRepository, type PendingEventRange } from '../../../src/modules/sessions/index.ts'
import { withAccount, accountKey, type Account } from '../../../src/modules/accounts/index.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'mon')
  return { database, sessions }
}

function drain(sessions: SessionRepository, source: readonly PendingEventRange[]): DurableEvent[] {
  const ranges = source.map(range => ({ ...range }))
  const received: DurableEvent[] = []
  for (let count = 0; count < 20; count++) {
    const next = sessions.events.nextPending(ranges)
    if (!next) return received
    received.push(next)
    ranges.find(range => range.sessionId === next.sessionId)!.afterSeq = next.seq
  }
  throw new Error('Pending event cursor did not advance')
}

test('pending ranges merge sessions by insertion order and independently restore equal sequence numbers', t => {
  const { database, sessions } = fixture(t)
  const first = sessions.create('First'), second = sessions.create('Second')
  const update = (id: string, text: string) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    return sessions.events.append(id, null, 'agent.message_update', { messageId: 'same-message-id', message,
      assistantMessageEvent: { type: 'text_delta', delta: text.at(-1)!, partial: message } })
  }
  update(first.id, 'A'.repeat(1000))
  update(second.id, 'B'.repeat(1000))
  const expected = [update(first.id, 'A'.repeat(1001)), update(second.id, 'B'.repeat(1001))]
  for (const [session, text] of [[first, 'first'], [second, 'second']] as const) {
    expected.push(sessions.events.append(session.id, null, 'model.request', {
      payload: { messages: [{ role: 'assistant', content: text.repeat(1000) }] },
    }))
  }
  for (const event of expected.slice(0, 2)) {
    const stored = JSON.parse(String(database.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(event.id)?.payload_json))
    assert.equal(stored.messageStorage.baseSeq, '2', 'The requested range starts after its delta base')
  }
  const ranges = [second, first].map(session => ({ sessionId: session.id, afterSeq: '2', throughSeq: '4' }))
  assert.deepEqual(sessions.events.nextPending(ranges), expected[0])
  assert.deepEqual(drain(sessions, ranges), expected)
})

test('empty, exhausted and inverted pending ranges yield no event and missing next sequences are never skipped', t => {
  const { database, sessions } = fixture(t)
  const session = sessions.create('Range endings')
  assert.equal(sessions.events.nextPending([]), undefined)
  for (const [afterSeq, throughSeq] of [['1', '1'], ['2', '1'], ['1', '20']]) {
    assert.equal(sessions.events.nextPending([{ sessionId: session.id, afterSeq: afterSeq!, throughSeq: throughSeq! }]), undefined)
  }
  const laterId = randomUUID()
  database.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
    .run(laterId, session.id, null, 3, 'fixture.after_missing_sequence', '{}', Date.now())
  assert.equal(sessions.events.nextPending([{ sessionId: session.id, afterSeq: '1', throughSeq: '3' }]), undefined)
  assert.equal(sessions.events.nextPending([{ sessionId: session.id, afterSeq: '2', throughSeq: '3' }])?.id, laterId)
})

test('pending range bounds and returned sequences retain integers beyond the JavaScript safe range', t => {
  const { database, sessions } = fixture(t)
  const session = sessions.create('Large sequence')
  const firstSequence = 9_007_199_254_740_993n
  const ids = [randomUUID(), randomUUID()]
  ids.forEach((id, index) => {
    database.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
      .run(id, session.id, null, firstSequence + BigInt(index), 'fixture.large_sequence', '{}', Date.now())
  })
  const first = sessions.events.nextPending([{ sessionId: session.id, afterSeq: String(firstSequence - 1n), throughSeq: String(firstSequence) }])
  assert.equal(first?.id, ids[0])
  assert.equal(first?.seq, String(firstSequence))
  const second = sessions.events.nextPending([{ sessionId: session.id, afterSeq: String(firstSequence), throughSeq: String(firstSequence + 1n) }])
  assert.equal(second?.id, ids[1])
  assert.equal(second?.seq, String(firstSequence + 1n))
  const maximum = 9_223_372_036_854_775_807n, finalId = randomUUID()
  database.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
    .run(finalId, session.id, null, maximum, 'fixture.final_sequence', '{}', Date.now())
  assert.equal(sessions.events.nextPending([{ sessionId: session.id, afterSeq: String(maximum - 1n), throughSeq: String(maximum) }])?.id, finalId)
  assert.equal(sessions.events.nextPending([{ sessionId: session.id, afterSeq: String(maximum), throughSeq: String(maximum) }]), undefined)
  assert.equal(sessions.events.nextPending([{ sessionId: session.id, afterSeq: String(maximum), throughSeq: '0' }]), undefined)
})

test('a soft-deleted session still exposes its unseen deletion event', t => {
  const { database, sessions } = fixture(t)
  const session = sessions.create('Delete while waiting')
  sessions.setStatus(session.id, 'deleted')
  assert.equal(database.connection.prepare('SELECT status FROM sessions WHERE id=?').get(session.id)?.status, 'deleted')
  const next = sessions.events.nextPending([{ sessionId: session.id, afterSeq: '1', throughSeq: '2' }])
  assert.equal(next?.sessionId, session.id)
  assert.equal(next?.kind, 'session.deleted')
})

test('every pending session range requires the current account ownership before any result is returned', t => {
  const { sessions } = fixture(t)
  const account = (userId: string): Account => ({ userId, coreBaseUrl: 'http://127.0.0.1:40011', key: accountKey('http://127.0.0.1:40011', userId) })
  const a = account('101'), b = account('202')
  const first = withAccount(a, () => sessions.create('Account A'))
  const second = withAccount(b, () => sessions.create('Account B'))
  const ranges = [first, second].map(session => ({ sessionId: session.id, afterSeq: '0', throughSeq: '1' }))
  assert.throws(() => withAccount(a, () => sessions.events.nextPending(ranges)), /不属于当前账号/)
  assert.equal(withAccount(b, () => sessions.events.nextPending([ranges[1]!]))?.sessionId, second.id)
})

test('only the selected event payload is restored, even when another matching row is corrupt', t => {
  const { sessions, database } = fixture(t)
  const session = sessions.create('One payload at a time')
  const first = sessions.events.append(session.id, null, 'operation.completed', { result: 'first' })
  const later = sessions.events.append(session.id, null, 'operation.completed', { result: 'later' })
  database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run('invalid JSON', later.id)
  const range = { sessionId: session.id, afterSeq: '1', throughSeq: later.seq }
  assert.deepEqual(sessions.events.nextPending([range]), first)
  assert.throws(() => sessions.events.nextPending([{ ...range, afterSeq: first.seq }]), SyntaxError)
})

test('pending reads exclude already sent media and unpublished bounds without publishing or mutating events', t => {
  const { sessions, database } = fixture(t)
  const session = sessions.create('Only unsent live events'), unrelated = sessions.create('Unrelated history')
  const sent = sessions.events.append(session.id, null, 'media.requested', { id: 'already-sent-media' })
  const expected = sessions.events.append(session.id, null, 'operation.completed', { callId: 'held-tool', result: 'done' })
  sessions.events.append(unrelated.id, null, 'media.requested', { id: 'unrelated-media' })
  sessions.events.append(session.id, null, 'media.requested', { id: 'outside-published-bound' })
  const count = database.connection.prepare('SELECT count(*) AS count FROM events').get()?.count
  let broadcasts = 0
  sessions.events.subscribe(() => broadcasts++)
  const ranges = [{ sessionId: session.id, afterSeq: sent.seq, throughSeq: expected.seq }]
  assert.deepEqual(drain(sessions, ranges), [expected])
  assert.equal(broadcasts, 0)
  assert.equal(database.connection.prepare('SELECT count(*) AS count FROM events').get()?.count, count)
  assert.deepEqual(ranges, [{ sessionId: session.id, afterSeq: sent.seq, throughSeq: expected.seq }])
})
