import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import type { DurableEvent } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { EventReadCache } from '../../../src/modules/sessions/event-read-cache.ts'
import { withAccount, accountKey, type Account } from '../../../src/modules/accounts/index.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'mon')
  const session = sessions.create('Cached stream')
  const update = (text: string) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    return sessions.events.append(session.id, null, 'agent.message_update', { messageId: 'message', message,
      assistantMessageEvent: { type: 'text_delta', delta: text.at(-1) ?? '', partial: message } })
  }
  const next = (event: DurableEvent) => sessions.events.nextPending([{ sessionId: session.id,
    afterSeq: String(BigInt(event.seq) - 1n), throughSeq: event.seq }])
  return { database, sessions, session, update, next }
}

test('pending delivery reuses restored bases across calls without retaining an unbounded history map', t => {
  const f = fixture(t)
  const expected = Array.from({ length: 120 }, (_, i) => f.update('x'.repeat(2000 + i)))
  let baseReads = 0
  const prepare = f.database.connection.prepare.bind(f.database.connection)
  f.database.connection.prepare = sql => {
    if (sql === 'SELECT * FROM events WHERE session_id=? AND seq=?') baseReads++
    return prepare(sql)
  }
  assert.deepEqual(f.next(expected[100]!), expected[100])
  assert.ok(baseReads >= 100)
  const before = baseReads
  for (const event of expected.slice(101)) assert.deepEqual(f.next(event), event)
  assert.equal(baseReads - before, 19, 'Each following delta reads only its immediate cached base')
})

test('shared cache keys include the session and returned payload mutation cannot poison later reads', t => {
  const f = fixture(t), other = f.sessions.create('Other session')
  const first = f.update('first')
  const second = f.sessions.events.append(other.id, null, 'fixture', { text: 'second' })
  const received = f.next(first)!
  received.payload = { compromised: true }
  assert.deepEqual(f.next(first), first)
  assert.deepEqual(f.sessions.events.nextPending([{ sessionId: other.id, afterSeq: '1', throughSeq: '2' }]), second)
})

test('cache invalidation preserves missing and corrupt delta-base failures after an earlier successful read', t => {
  const f = fixture(t), base = f.update('x'.repeat(2000)), delta = f.update('x'.repeat(2001))
  assert.deepEqual(f.next(delta), delta)
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run('invalid JSON', base.id)
  assert.throws(() => f.next(delta), SyntaxError)
  f.database.connection.prepare('DELETE FROM events WHERE id=?').run(base.id)
  assert.throws(() => f.next(delta), /Missing persisted message delta event/)
})

test('a warmed cache still checks every pending range ownership before returning anything', t => {
  const f = fixture(t)
  const account = (userId: string): Account => ({ userId, coreBaseUrl: 'http://fixture.invalid', key: accountKey('http://fixture.invalid', userId) })
  const owner = account('owner'), stranger = account('stranger')
  const session = withAccount(owner, () => f.sessions.create('Private'))
  const ranges = [{ sessionId: session.id, afterSeq: '0', throughSeq: '1' }]
  assert.ok(withAccount(owner, () => f.sessions.events.nextPending(ranges)))
  assert.throws(() => withAccount(stranger, () => f.sessions.events.nextPending(ranges)), /不属于当前账号/)
})

test('rolled-back temporary read results never escape the owning transaction', t => {
  const f = fixture(t), event = f.update('original')
  assert.throws(() => f.database.transaction(() => {
    f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run(JSON.stringify({ temporary: true }), event.id)
    assert.deepEqual(f.next(event)?.payload, { temporary: true })
    throw new Error('rollback fixture')
  }), /rollback fixture/)
  assert.deepEqual(f.next(event), event)
})

test('external writes invalidate warmed data before a missing delta base can be concealed', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'eden-event-cache-'))
  const filename = path.join(directory, 'fixture.db')
  const database = new EdenDatabase(filename, 'mon')
  const external = new DatabaseSync(filename)
  t.after(() => { external.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  const sessions = new SessionRepository(database, 'mon'), session = sessions.create('External mutation')
  const update = (text: string) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    return sessions.events.append(session.id, null, 'agent.message_update', { messageId: 'message', message,
      assistantMessageEvent: { type: 'text_delta', partial: message } })
  }
  const base = update('x'.repeat(2000)), delta = update('x'.repeat(2001))
  const ranges = [{ sessionId: session.id, afterSeq: base.seq, throughSeq: delta.seq }]
  assert.deepEqual(sessions.events.nextPending(ranges), delta)
  external.prepare('DELETE FROM events WHERE id=?').run(base.id)
  assert.throws(() => sessions.events.nextPending(ranges), /Missing persisted message delta event/)
})

test('read cache evicts by both entry count and serialized byte budget', () => {
  const event = (sessionId: string, seq: string, text = ''): DurableEvent => ({
    id: randomUUID(), sessionId, turnId: null, seq, kind: 'fixture', payload: { text }, createdAt: 0,
  })
  const countCache = new EventReadCache(2, 10000)
  countCache.set(event('a', '1')); countCache.set(event('b', '1'))
  assert.ok(countCache.get('a', '1'))
  countCache.set(event('a', '2'))
  assert.equal(countCache.get('b', '1'), undefined)
  assert.ok(countCache.get('a', '1'))
  const byteCache = new EventReadCache(100, 600)
  byteCache.set(event('a', '1', 'x'.repeat(300)))
  byteCache.set(event('a', '2', 'x'.repeat(300)))
  assert.equal(byteCache.get('a', '1'), undefined)
  assert.ok(byteCache.get('a', '2'))
  byteCache.set(event('a', '3', 'x'.repeat(1000)))
  assert.equal(byteCache.get('a', '3'), undefined)
})
