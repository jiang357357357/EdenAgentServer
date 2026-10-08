import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import type { DurableEvent, JsonValue } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'local')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'local'), session = sessions.create('Reply timing')
  let seq = 1
  const append = (turnId: string | null, kind: string, createdAt: number, payload: JsonValue = {}, sessionId = session.id) => {
    const id = randomUUID()
    database.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
      .run(id, sessionId, turnId, ++seq, kind, JSON.stringify(payload), createdAt)
    return id
  }
  return { database, sessions, session, append }
}

function timing(event: DurableEvent): JsonValue | undefined {
  return (event.payload as Record<string, JsonValue>).turnTiming
}

const assistant = { message: { role: 'assistant', timestamp: 8_000, content: [{ type: 'text', text: 'Done' }] } }

test('completed reply includes the whole persisted turn across tools, pagination and repository recreation', t => {
  const f = fixture(t), turnId = randomUUID()
  f.append(turnId, 'turn.started', 1_000)
  f.append(turnId, 'agent.message_end', 1_500, { message: { role: 'user', content: 'Please do this' } })
  f.append(turnId, 'agent.message_end', 2_000, { message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec_command' }] } })
  f.append(turnId, 'agent.message_end', 7_500, { message: { role: 'toolResult', content: 'Finished command' } })
  const messageId = f.append(turnId, 'agent.message_end', 8_000, assistant)
  f.append(turnId, 'turn.completed', 9_000)
  const page = new SessionRepository(f.database, 'local').events.messages(f.session.id, undefined, 1)
  assert.equal(page.items[0]!.id, messageId)
  assert.deepEqual(timing(page.items[0]!), { startedAt: 1_000, completedAt: 9_000 })
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, messageId)
  assert.deepEqual(JSON.parse(String(f.database.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(messageId)!.payload_json)), assistant)
  const earlier = f.sessions.events.messages(f.session.id, page.nextCursor!, 10)
  assert.equal(earlier.items.length, 3)
  assert.equal(timing(earlier.items[0]!), undefined)
  assert.deepEqual(timing(earlier.items[1]!), { startedAt: 1_000, completedAt: 9_000 })
  assert.equal(timing(earlier.items[2]!), undefined)
})

test('running and interrupted turns restore their start without pretending the answer completed', t => {
  const f = fixture(t), turnId = randomUUID()
  f.append(turnId, 'turn.started', 1_000)
  f.append(turnId, 'agent.message_end', 2_000, assistant)
  const read = () => timing(f.sessions.events.messages(f.session.id, undefined, 1).items[0]!)
  assert.deepEqual(read(), { startedAt: 1_000 })
  f.append(turnId, 'input.interrupted', 5_000, { reason: 'Server restarted during execution' })
  assert.deepEqual(read(), { startedAt: 1_000 })
})

test('missing starts and invalid durations do not manufacture a completed answer duration', t => {
  const f = fixture(t), missing = randomUUID(), backwards = randomUUID()
  f.append(missing, 'agent.message_end', 2_000, assistant)
  f.append(missing, 'turn.completed', 3_000)
  f.append(backwards, 'turn.started', 5_000)
  f.append(backwards, 'agent.message_end', 6_000, assistant)
  f.append(backwards, 'turn.completed', 4_000)
  f.append(null, 'agent.message_end', 7_000, assistant)
  const items = f.sessions.events.messages(f.session.id, undefined, 10).items
  assert.equal(timing(items[0]!), undefined)
  assert.deepEqual(timing(items[1]!), { startedAt: 5_000 })
  assert.equal(timing(items[2]!), undefined)
})

test('turn identifiers never pull timing from another session', t => {
  const f = fixture(t), turnId = randomUUID(), other = f.sessions.create('Other session')
  f.append(turnId, 'turn.started', 1_000, {}, other.id)
  f.append(turnId, 'turn.completed', 9_000, {}, other.id)
  f.append(turnId, 'agent.message_end', 8_000, assistant)
  assert.equal(timing(f.sessions.events.messages(f.session.id, undefined, 1).items[0]!), undefined)
})

test('reply timing skips unrelated stream payloads and seeks indexed turn boundaries', t => {
  const f = fixture(t), turnId = randomUUID()
  f.append(turnId, 'turn.started', 1_000)
  f.append(turnId, 'agent.message_end', 2_000, assistant)
  f.append(turnId, 'turn.completed', 9_000)
  f.database.connection.prepare(`WITH RECURSIVE stream(n) AS (SELECT 10 UNION ALL SELECT n+1 FROM stream WHERE n<10009)
    INSERT INTO events SELECT 'timing-stream-'||n,?,?,n,'agent.message_update','not JSON',n FROM stream`).run(f.session.id, turnId)
  const prepare = f.database.connection.prepare.bind(f.database.connection), queries: string[] = []
  t.mock.method(f.database.connection, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql) })
  assert.deepEqual(timing(f.sessions.events.messages(f.session.id, undefined, 1).items[0]!), { startedAt: 1_000, completedAt: 9_000 })
  const boundary = queries.find(sql => sql.includes('events_session_turn_kind_seq'))
  assert.ok(boundary)
  const plan = prepare(`EXPLAIN QUERY PLAN ${boundary}`).all(f.session.id, turnId, 'turn.started')
  assert.ok(plan.some(row => /SEARCH .*events.*session_id=\? AND turn_id=\? AND kind=\?/.test(String(row.detail))))
  assert.ok(plan.every(row => !/SCAN events|USE TEMP B-TREE/.test(String(row.detail))))
})

test('completion carries the exact persisted start for a client that reconnected before the first reply', t => {
  const f = fixture(t), inputs = new InputRepository(f.database, f.sessions.events)
  const published: DurableEvent[] = []
  f.sessions.events.subscribe(event => published.push(event))
  let now = 100
  t.mock.method(Date, 'now', () => now)
  inputs.enqueue(f.session.id, 'Reply after reconnect', 'reply-timing-fixture')
  now = 1_000
  const input = inputs.claim(f.session.id)!
  // Table creation and event insertion can have different millisecond timestamps.
  f.database.connection.prepare('UPDATE turns SET created_at=? WHERE id=?').run(999, input.turnId)
  assert.equal(f.sessions.events.messages(f.session.id, undefined, 1).items.length, 0)
  now = 8_000
  f.sessions.events.append(f.session.id, input.turnId, 'agent.message_end', assistant)
  now = 9_000
  inputs.finish(input)
  const completion = published.at(-1)!
  assert.equal(completion.kind, 'turn.completed')
  assert.equal(completion.turnId, input.turnId)
  assert.equal(completion.createdAt, 9_000)
  assert.deepEqual(timing(completion), { startedAt: 1_000 })
  const persisted = f.database.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(completion.id)!
  assert.deepEqual(JSON.parse(String(persisted.payload_json)), { inputId: input.id, reason: null, turnTiming: { startedAt: 1_000 } })
  assert.deepEqual(timing(f.sessions.events.messages(f.session.id, undefined, 1).items[0]!), { startedAt: 1_000, completedAt: 9_000 })
})

test('interrupted input completion never advertises successful turn timing', t => {
  const f = fixture(t), inputs = new InputRepository(f.database, f.sessions.events)
  const published: DurableEvent[] = []
  f.sessions.events.subscribe(event => published.push(event))
  inputs.enqueue(f.session.id, 'Interrupted request', 'interrupted-timing-fixture')
  const input = inputs.claim(f.session.id)!
  inputs.finish(input, 'Cancelled by user')
  const interrupted = published.at(-1)!
  assert.equal(interrupted.kind, 'input.interrupted')
  assert.equal(timing(interrupted), undefined)
})

test('completion omits missing or invalid start timestamps without borrowing another session start', t => {
  const f = fixture(t), inputs = new InputRepository(f.database, f.sessions.events), other = f.sessions.create('Other timing')
  const published: DurableEvent[] = []
  f.sessions.events.subscribe(event => published.push(event))
  for (const invalid of [null, -1, 9_007_199_254_740_992n]) {
    inputs.enqueue(f.session.id, 'Missing or invalid start', `invalid-${String(invalid)}`)
    const input = inputs.claim(f.session.id)!
    if (invalid === null) {
      f.database.connection.prepare("DELETE FROM events WHERE session_id=? AND turn_id=? AND kind='turn.started'").run(f.session.id, input.turnId)
      f.sessions.events.append(other.id, input.turnId, 'turn.started', {})
    } else {
      f.database.connection.prepare("UPDATE events SET created_at=? WHERE session_id=? AND turn_id=? AND kind='turn.started'").run(invalid, f.session.id, input.turnId)
    }
    inputs.finish(input)
    assert.equal(published.at(-1)!.kind, 'turn.completed')
    assert.equal(timing(published.at(-1)!), undefined)
  }
})
