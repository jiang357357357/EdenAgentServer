import test from 'node:test'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import type { JsonValue } from '@eden/api'

function fixture(context: test.TestContext) {
  const db = new EdenDatabase(':memory:', 'mon')
  context.after(() => db.close())
  const sessions = new SessionRepository(db, 'mon')
  const session = sessions.create('Request storage')
  const snapshot = { model: 'fixture', provider: 'fixture', requestId: 'request', actor: { assistantID: 'actor' },
    contextEstimate: { prefixGeneration: 3 }, tools: [{ name: 'tool', description: 'description'.repeat(200) }],
    payload: { messages: [{ role: 'system', content: 'system'.repeat(2000) }, { role: 'user', content: 'user'.repeat(1000) }],
      tools: [{ type: 'function', function: { name: 'tool', description: 'description'.repeat(200) } }], temperature: 0.5 } }
  return { db, sessions, session, snapshot }
}

test('growing request histories reuse content and replay exact snapshots with SQL metadata intact', context => {
  const f = fixture(context)
  const live: JsonValue[] = []
  f.sessions.events.subscribe(event => live.push(event.payload))
  const expected = []
  for (let i = 0; i < 20; i++) {
    const value = structuredClone(f.snapshot)
    value.requestId = String(i)
    for (let j = 0; j < i; j++) value.payload.messages.push({ role: 'assistant', content: `reply-${j}:` + 'z'.repeat(1000) })
    expected.push(f.sessions.events.append(f.session.id, null, 'model.request', value))
  }
  assert.deepEqual(live, expected.map(event => event.payload))
  const reopened = new SessionRepository(f.db, 'mon')
  assert.deepEqual(reopened.events.list(f.session.id, '1'), expected)
  const rows = f.db.connection.prepare("SELECT json_extract(payload_json,'$.actor.assistantID') AS actor,json_extract(payload_json,'$.contextEstimate.prefixGeneration') AS generation FROM events WHERE kind='model.request'").all()
  assert.ok(rows.every(row => row.actor === 'actor' && row.generation === 3))
  const original = expected.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload)), 0)
  const bytes = Number(f.db.connection.prepare("SELECT sum(length(CAST(payload_json AS BLOB))) AS n FROM events WHERE kind='model.request'").get()?.n)
    + Number(f.db.connection.prepare('SELECT sum(length(CAST(content_json AS BLOB))+length(hash)) AS n FROM request_contents').get()?.n)
  context.diagnostic(`Request JSON and hashes: ${original} -> ${bytes} bytes`)
  assert.ok(bytes < original / 4)
})

test('director and memory requests restore nested snapshots and tiny/legacy records remain compatible', context => {
  const f = fixture(context)
  const expected = [f.sessions.events.append(f.session.id, null, 'director.model.request', f.snapshot),
    f.sessions.events.append(f.session.id, null, 'memory.extraction.model_request', { jobId: 'job', snapshot: f.snapshot }),
    f.sessions.events.append(f.session.id, null, 'model.request', { payload: { messages: [] }, requestId: 'tiny' })]
  assert.deepEqual(f.sessions.events.list(f.session.id, '1'), expected)
  const raw = { ...f.snapshot, requestId: 'legacy' }
  f.db.connection.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(randomUUID(), f.session.id, null, 5, 'model.request', JSON.stringify(raw), 0)
  assert.deepEqual(f.sessions.events.list(f.session.id, '4')[0]!.payload, raw)
})

test('event write failure rolls back new content and does not broadcast', context => {
  const f = fixture(context)
  let published = 0
  f.sessions.events.subscribe(() => published++)
  f.db.connection.exec("CREATE TRIGGER fail_request BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'request disk failure'); END")
  assert.throws(() => f.sessions.events.append(f.session.id, null, 'model.request', f.snapshot), /disk failure/)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM request_contents').get()?.n, 0)
  assert.equal(published, 0)
})

test('missing or corrupted content is rejected rather than returning an incomplete audit snapshot', context => {
  const f = fixture(context)
  f.sessions.events.append(f.session.id, null, 'model.request', f.snapshot)
  f.db.connection.exec("UPDATE request_contents SET content_json='null'")
  assert.throws(() => f.sessions.events.append(f.session.id, null, 'model.request', f.snapshot), /Corrupt existing request content/)
  assert.throws(() => f.sessions.events.list(f.session.id, '1'), /corrupt request content/)
  f.db.connection.exec('DELETE FROM request_contents')
  assert.throws(() => f.sessions.events.list(f.session.id, '1'), /Missing or corrupt/)
})
