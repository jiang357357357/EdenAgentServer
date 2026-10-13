import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import type { JsonValue, DurableEvent } from '@eden/api'

function fixture(context: test.TestContext) {
  const db = new EdenDatabase(':memory:', 'mon')
  context.after(() => db.close())
  const sessions = new SessionRepository(db, 'mon')
  const session = sessions.create('Stream fixture')
  const received: DurableEvent[] = []
  sessions.events.subscribe(event => received.push(event))
  const append = (text: string, type = 'text_delta', extra: Record<string, JsonValue> = {}) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }], ...extra }
    return sessions.events.append(session.id, null, 'agent.message_update', { messageId: 'message', message,
      assistantMessageEvent: { type, contentIndex: 0, delta: text.at(-1) ?? '', partial: message } })
  }
  return { db, sessions, session, received, append }
}

test('stream disk growth is bounded while broadcast and paginated replay remain exact', context => {
  const f = fixture(context)
  const expected: DurableEvent[] = []
  for (let i = 1; i <= 400; i++) expected.push(f.append('中'.repeat(i * 10)))
  assert.deepEqual(f.received, expected)
  const disk = f.db.connection.prepare("SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM events WHERE kind='agent.message_update'").get()!
  const original = expected.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload)), 0)
  context.diagnostic(`Stream JSON bytes: ${original} -> ${disk.bytes} (${(100 * (1 - Number(disk.bytes) / original)).toFixed(2)}% smaller)`)
  assert.ok(Number(disk.bytes) < original / 10, `${disk.bytes} vs ${original}`)
  const reopened = new SessionRepository(f.db, 'mon')
  // Start in the middle of a chain, then cross snapshots and page boundaries.
  assert.deepEqual(reopened.events.list(f.session.id, expected[176]!.seq, 100), expected.slice(177, 277))
  assert.deepEqual(reopened.events.list(f.session.id, expected[398]!.seq, 1), expected.slice(399))
})

test('replacement, thinking, tool arguments, removals and final messages preserve exact payloads', context => {
  const f = fixture(context)
  const expected = [f.append('first'), f.append('replaced', 'thinking_delta', { usage: { input: 9 } }),
    f.append('replaced plus', 'toolcall_delta', { content: [{ type: 'toolCall', id: 'call', name: 'tool', arguments: { value: 'a' } }] }),
    f.append('last', 'text_end')]
  expected.push(f.sessions.events.append(f.session.id, null, 'agent.message_end', { messageId: 'message', message: { role: 'assistant', content: 'complete' } }))
  assert.deepEqual(f.sessions.events.list(f.session.id, '1'), expected)
  assert.equal(f.sessions.events.messages(f.session.id, undefined, 10).items.length, 1)
})

test('rolled back inserts do not become delta bases and persistence failure publishes nothing', context => {
  const f = fixture(context)
  const first = f.append('prefix')
  assert.throws(() => f.db.transaction(() => {
    f.sessions.events.insert(f.session.id, null, 'agent.message_update', { messageId: 'message', message: { role: 'assistant', content: [] } })
    throw new Error('rollback')
  }), /rollback/)
  const next = f.append('prefix next')
  assert.deepEqual(f.sessions.events.list(f.session.id, first.seq), [next])
  f.db.connection.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  assert.throws(() => f.append('prefix failed'), /disk failure/)
  assert.equal(f.received.length, 2)
})

test('legacy updates and unequal SDK partials remain readable without losing fields', context => {
  const f = fixture(context)
  const payload = { messageId: 'legacy', message: { role: 'assistant', content: 'legacy' }, assistantMessageEvent: { partial: { content: 'different' } } }
  const event = f.sessions.events.append(f.session.id, null, 'agent.message_update', payload)
  assert.deepEqual(f.sessions.events.list(f.session.id, '1'), [event])
  const stored = JSON.parse(String(f.db.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(event.id)?.payload_json))
  assert.equal(stored.messageStorage.format, 'eden.message.delta.v2')
})

test('large unequal SDK partials compact independently and replay their exact fields', context => {
  const f = fixture(context), expected: DurableEvent[] = []
  for (let index = 0; index < 48; index++) {
    const text = 'x'.repeat(330_000 + index)
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    const partial = { ...message, sdkOnly: { key: index, removed: index < 24 ? true : null } }
    expected.push(f.sessions.events.append(f.session.id, null, 'agent.message_update', { messageId: 'large', message,
      assistantMessageEvent: { type: 'text_delta', delta: 'x', partial } }))
  }
  const original = expected.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event.payload)), 0)
  const stored = Number(f.db.connection.prepare("SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM events WHERE kind='agent.message_update'").get()!.bytes)
  context.diagnostic(`Unequal SDK partial bytes: ${original} -> ${stored}`)
  assert.ok(stored < original / 20)
  const reopened = new SessionRepository(f.db, 'mon')
  assert.deepEqual(reopened.events.list(f.session.id, '1', 100), expected)
  assert.deepEqual(reopened.events.list(f.session.id, expected[30]!.seq, 10), expected.slice(31, 41))
})

test('distinct partial text, absent partials and scalar partials survive snapshots and restart', context => {
  const f = fixture(context), expected: DurableEvent[] = []
  for (let index = 0; index < 270; index++) {
    const message = { role: 'assistant', content: 'body'.repeat(1000 + index) }
    const stream: Record<string, JsonValue> = { type: 'text_delta' }
    if (index % 7 === 0) stream.partial = null
    else if (index % 7 !== 1) stream.partial = { role: 'assistant', content: 'separate'.repeat(1000 + index), sdk: index }
    expected.push(f.sessions.events.append(f.session.id, null, 'agent.message_update', { messageId: 'distinct', message, assistantMessageEvent: stream }))
  }
  const reopened = new SessionRepository(f.db, 'mon')
  assert.deepEqual(reopened.events.list(f.session.id, '1', 1000), expected)
})

test('old raw and v1 events mix with v2 events without changing public replay', context => {
  const f = fixture(context)
  const payload = { messageId: 'old', message: { role: 'assistant', content: 'legacy' }, assistantMessageEvent: { partial: { extra: true } } }
  const old = f.sessions.events.append(f.session.id, null, 'agent.message_update', payload)
  f.db.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run(JSON.stringify(payload), old.id)
  const message = { role: 'assistant', content: 'old snapshot' }
  const previous = f.sessions.events.append(f.session.id, null, 'agent.message_update', { messageId: 'v1', message, assistantMessageEvent: { partial: message } })
  f.db.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run(JSON.stringify({ messageId: 'v1', assistantMessageEvent: {},
    messageStorage: { format: 'eden.message.delta.v1', snapshot: message } }), previous.id)
  const continuedMessage = { role: 'assistant', content: 'old snapshot tail' }
  const continued = f.sessions.events.append(f.session.id, null, 'agent.message_update', { messageId: 'v1', message: continuedMessage,
    assistantMessageEvent: { partial: continuedMessage } })
  f.db.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run(JSON.stringify({ messageId: 'v1', assistantMessageEvent: {},
    messageStorage: { format: 'eden.message.delta.v1', baseSeq: previous.seq, patches: [{ path: ['content'], append: ' tail' }] } }), continued.id)
  const next = f.append('new event')
  assert.deepEqual(new SessionRepository(f.db, 'mon').events.list(f.session.id, '1'), [old, previous, continued, next])
})

test('missing delta bases fail explicitly rather than silently returning truncated text', context => {
  const f = fixture(context)
  f.append('x'.repeat(1000))
  const event = f.append('x'.repeat(1001))
  f.db.connection.prepare('DELETE FROM events WHERE seq=2').run()
  assert.throws(() => f.sessions.events.list(f.session.id, String(BigInt(event.seq) - 1n)), /Missing persisted message delta event/)
})

test('interleaved actors keep independent bases and a fresh writer starts with a snapshot', context => {
  const f = fixture(context)
  const expected: DurableEvent[] = []
  const write = (repository: SessionRepository, id: string, text: string) => {
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: text }] }
    expected.push(repository.events.append(f.session.id, null, 'actor.runtime.message_update', { messageId: id,
      actor: { assistantID: id }, message, assistantMessageEvent: { type: 'thinking_delta', delta: 'x', partial: message } }))
  }
  for (let i = 1; i <= 3; i++) {
    write(f.sessions, 'a', 'a'.repeat(i * 1000))
    write(f.sessions, 'b', 'b'.repeat(i * 1000))
  }
  const fresh = new SessionRepository(f.db, 'mon')
  write(fresh, 'a', 'a'.repeat(4000))
  assert.deepEqual(fresh.events.list(f.session.id, '1'), expected)
  const last = JSON.parse(String(f.db.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(expected.at(-1)!.id)?.payload_json))
  assert.ok(last.messageStorage.snapshot)
  assert.equal(last.messageStorage.baseSeq, undefined)
})
