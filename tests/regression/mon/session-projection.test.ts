import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import type { MonClient } from '@eden/integrations'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { MonProjectionConfigurationRequired, MonSessionProjection } from '../../../src/modules/mon/session-projection.ts'

function fixture(origin: 'mon' | 'local' = 'mon') {
  const database = new EdenDatabase(':memory:', origin)
  const sessions = new SessionRepository(database, origin)
  const projection = new MonSessionProjection(sessions)
  const calls: { method: string; path: string; body: JsonValue }[] = []
  const client = {
    async post(path: string, body: JsonValue) { calls.push({ method: 'POST', path, body }); return { id: 17 } },
    async put(path: string, body: JsonValue) { calls.push({ method: 'PUT', path, body }); return {} },
  } as unknown as MonClient
  return { database, sessions, projection, calls, client }
}

test('empty and invalid Mon rosters wait for configuration before any HTTP or outbox write', context => {
  const f = fixture()
  context.after(() => f.database.close())
  const rosters: JsonValue[][] = [[], [null], [{}], [{ assistantId: '' }], [{ assistantId: -1 }], [{ assistantId: 1.2 }],
    [{ assistantId: 'not-a-core-id' }], [{ assistantId: Number.MAX_SAFE_INTEGER + 1 }],
    [{ assistantId: 1 }, { assistantId: '01' }], Array.from({ length: 9 }, (_, i) => ({ assistantId: i + 1 }))]
  for (const roster of rosters) {
    const session = f.sessions.create('Draft', roster)
    assert.throws(() => f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal), MonProjectionConfigurationRequired)
  }
  assert.deepEqual(f.calls, [])
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM mon_projection_outbox').get()!.count, 0)
})

test('a configured roster recovers a draft and numeric string IDs follow the Core integer contract', async context => {
  const f = fixture()
  context.after(() => f.database.close())
  const session = f.sessions.create('Draft', [])
  assert.throws(() => f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal), MonProjectionConfigurationRequired)
  f.sessions.setMetadata(session.id, [{ assistantId: ' 5 ', characterId: 9 }])
  assert.equal(await f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal), '17')
  assert.deepEqual(f.calls.at(-1)!.body, { assistant_ids: [5], mode: 'companion' })
  assert.deepEqual(f.database.connection.prepare('SELECT state FROM mon_projection_outbox').all().map(row => row.state), ['applied'])
})

test('local drafts remain legal and cannot create a Core projection', context => {
  const f = fixture('local')
  context.after(() => f.database.close())
  const session = f.sessions.create('Local draft')
  assert.deepEqual(session.participants, [])
  assert.throws(() => f.projection.ensure(f.client, session.id, 'not-a-mon-connection', new AbortController().signal), MonProjectionConfigurationRequired)
  assert.deepEqual(f.calls, [])
})

test('legacy identity reconciliation stays separate from ordinary draft configuration', context => {
  const f = fixture()
  context.after(() => f.database.close())
  const session = f.sessions.create('Imported', [{ assistantId: 5 }])
  f.database.connection.prepare('INSERT INTO legacy_core_identities VALUES(?,?,?,?,?,?)')
    .run(session.id, 'http://127.0.0.1:1', 'fixture-owner', 'fixture-ref', 'rebind_required', Date.now())
  assert.throws(() => f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal), /Legacy Core identity/)
  assert.deepEqual(f.calls, [])
})

test('unconfirmed HTTP delivery remains unknown and is retried idempotently', async context => {
  const f = fixture()
  context.after(() => f.database.close())
  const session = f.sessions.create('Configured', [{ assistantId: 5 }])
  const put = f.client.put.bind(f.client)
  f.client.put = async () => { throw new Error('fixture transport interruption') }
  await assert.rejects(f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal), /transport interruption/)
  assert.equal(f.database.connection.prepare('SELECT state FROM mon_projection_outbox').get()!.state, 'unknown')
  f.client.put = put
  await f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal)
  assert.deepEqual(f.database.connection.prepare('SELECT state FROM mon_projection_outbox').all().map(row => row.state), ['applied'])
})

test('stream activity does not change a session projection key, while participant changes do', async context => {
  const f = fixture()
  context.after(() => f.database.close())
  const session = f.sessions.create('Configured', [{ assistantId: 5 }])
  await f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal)
  f.sessions.events.append(session.id, null, 'agent.message_update', { message: { role: 'assistant', content: [] } })
  f.database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(session.updatedAt + 10000, session.id)
  await f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal)
  assert.equal(f.calls.length, 2)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM mon_projection_outbox').get()!.count, 1)
  f.sessions.setMetadata(session.id, [{ assistantId: 6 }])
  await f.projection.ensure(f.client, session.id, 'owner-one', new AbortController().signal)
  assert.deepEqual(f.calls.at(-1)!.body, { assistant_ids: [6], mode: 'companion' })
  assert.equal(f.calls.length, 4)
})
