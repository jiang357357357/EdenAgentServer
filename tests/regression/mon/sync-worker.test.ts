import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import { MonClient } from '@eden/integrations'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { MonSessionProjection } from '../../../src/modules/mon/session-projection.ts'
import { MonSyncWorker } from '../../../src/modules/mon/sync-worker.ts'

function fixture(context: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  const sessions = new SessionRepository(database, 'mon')
  const connections = new MonConnectionRepository(database)
  const projection = new MonSessionProjection(sessions)
  const worker = new MonSyncWorker(sessions, connections, projection)
  const calls: { method: string; path: string; body: JsonValue }[] = []
  context.mock.method(globalThis, 'fetch', () => { throw new Error('Network is forbidden in this test') })
  context.mock.method(MonClient.prototype, 'post', async (path: string, body: JsonValue) => {
    calls.push({ method: 'POST', path, body })
    return path === '/api/agent/sessions/' ? { id: 17 } : { sync_status: 'synced' }
  })
  context.mock.method(MonClient.prototype, 'put', async (path: string, body: JsonValue) => {
    calls.push({ method: 'PUT', path, body })
    return {}
  })
  context.after(async () => { await worker.close(); database.close() })
  const create = (participants: JsonValue[]) => {
    const session = sessions.create('Fixture session', participants)
    database.transaction(() => connections.saveInTransaction(session.id, { coreBaseUrl: 'http://127.0.0.1:1', coreToken: 'fixture-token' }))
    return session
  }
  const progress = (sessionId: string) => database.connection.prepare('SELECT * FROM mon_sync_progress WHERE session_id=?').get(sessionId)!
  return { database, sessions, connections, projection, worker, calls, create, progress }
}

test('empty Mon drafts wait without HTTP, outbox rows or retry churn and resume after explicit configuration', async context => {
  const f = fixture(context)
  // An unrelated configured conversation must never supply the draft's identity.
  f.sessions.create('Another conversation', [{ assistantId: 88 }])
  const draft = f.create([])
  const ensure = context.mock.method(f.projection, 'ensure')
  const metadata = context.mock.method(f.sessions, 'readMetadata')
  await f.worker.syncPending()
  assert.match(String(f.progress(draft.id).error), /请为当前会话选择助手/)
  assert.equal(f.progress(draft.id).attempts, 0)
  assert.equal(f.progress(draft.id).retry_at, 0)
  assert.equal(f.progress(draft.id).after_seq, '0')
  f.sessions.events.append(draft.id, null, 'agent.message_update', {})
  await f.worker.syncPending()
  assert.equal(ensure.mock.callCount(), 1)
  assert.equal(metadata.mock.callCount(), 1)
  await f.worker.syncPending()
  assert.equal(metadata.mock.callCount(), 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM mon_projection_outbox').get()!.count, 0)
  assert.deepEqual(f.sessions.read(draft.id).participants, [])
  f.sessions.setMetadata(draft.id, [{ assistantId: '5', characterId: 9 }])
  await f.worker.syncPending()
  assert.equal(ensure.mock.callCount(), 2)
  assert.deepEqual(f.calls.at(-1)!.body, { assistant_ids: [5], mode: 'companion' })
  assert.equal(f.progress(draft.id).error, null)
  assert.equal(f.progress(draft.id).after_seq, '3')
})

test('stream-only backlogs advance one cursor without restoring deltas or publishing new session snapshots', async context => {
  const f = fixture(context)
  const session = f.create([{ assistantId: 5, characterId: 9 }])
  await f.worker.syncPending()
  const requestsBefore = f.calls.length
  const reads = context.mock.method(f.sessions, 'read')
  const metadata = context.mock.method(f.sessions, 'readMetadata')
  f.database.connection.exec(`CREATE TABLE cursor_changes (value TEXT);
    CREATE TRIGGER record_sync_cursor AFTER UPDATE OF after_seq ON mon_sync_progress
    BEGIN INSERT INTO cursor_changes VALUES(NEW.after_seq); END;`)
  for (let index = 0; index < 250; index++) {
    // Deliberately un-restorable payload: synchronization must not decode unrelated stream deltas.
    f.sessions.events.append(session.id, null, 'agent.message_update', {
      messageStorage: { format: 'eden.message.delta.v1', baseSeq: '999999', patches: [] }, assistantMessageEvent: {},
    })
  }
  await f.worker.syncPending()
  assert.equal(f.calls.length, requestsBefore)
  assert.equal(reads.mock.callCount(), 0)
  assert.equal(metadata.mock.callCount(), 0)
  assert.equal(f.progress(session.id).after_seq, '251')
  assert.equal(f.progress(session.id).error, null)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM cursor_changes').get()!.count, 1)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM mon_projection_outbox').get()!.count, 1)
  const completed = f.sessions.events.append(session.id, null, 'agent.message_end', {
    messageId: 'fixture-message', message: { role: 'assistant', content: [{ type: 'text', text: 'Complete response' }] },
  })
  await f.worker.syncPending()
  assert.equal(f.progress(session.id).after_seq, completed.seq)
  assert.equal(f.calls.filter(call => call.path.endsWith('/messages/')).length, 1)
})

test('failed delivery leaves the batch cursor unchanged and restart retries without duplicating confirmed messages', async context => {
  const f = fixture(context)
  const session = f.create([{ assistantId: 5 }])
  const append = (id: string) => f.sessions.events.append(session.id, null, 'agent.message_end', {
    messageId: id, message: { role: 'user', content: [{ type: 'text', text: id }] },
  })
  append('first')
  const second = append('second')
  let rejectSecond = true
  const deliveries: string[] = []
  context.mock.method(MonClient.prototype, 'post', async (path: string, body: JsonValue) => {
    if (path === '/api/agent/sessions/') return { id: 17 }
    const id = String((body as Record<string, JsonValue>).external_message_id)
    deliveries.push(id)
    if (id === 'second' && rejectSecond) throw new Error('fixture interrupted response')
    return { sync_status: 'synced' }
  })
  await f.worker.syncPending()
  assert.deepEqual(deliveries, ['first', 'second'])
  assert.equal(f.progress(session.id).after_seq, '0')
  assert.equal(f.progress(session.id).attempts, 1)
  rejectSecond = false
  f.database.connection.prepare('UPDATE mon_sync_progress SET retry_at=0').run()
  const restarted = new MonSyncWorker(f.sessions, f.connections, new MonSessionProjection(f.sessions))
  try { await restarted.syncPending() } finally { await restarted.close() }
  assert.deepEqual(deliveries, ['first', 'second', 'second'])
  assert.equal(f.progress(session.id).after_seq, second.seq)
  assert.equal(f.progress(session.id).attempts, 0)
  assert.equal(f.progress(session.id).error, null)
})

test('unchanged synchronized sessions skip metadata, projection reads and progress writes across sweeps', async context => {
  const f = fixture(context)
  const session = f.create([{ assistantId: 5 }])
  await f.worker.syncPending()
  const calls = f.calls.length
  const progress = { ...f.progress(session.id) }
  context.mock.method(f.sessions, 'read', () => { throw new Error('idle full read') })
  context.mock.method(f.sessions, 'readMetadata', () => { throw new Error('idle metadata read') })
  context.mock.method(f.sessions.events, 'projectionBatch', () => { throw new Error('idle projection read') })
  f.database.connection.exec(`CREATE TRIGGER reject_idle_progress_write BEFORE UPDATE ON mon_sync_progress
    BEGIN SELECT RAISE(ABORT,'idle cursor write'); END;`)
  for (let index = 0; index < 4; index++) await f.worker.syncPending()
  assert.equal(f.calls.length, calls)
  assert.deepEqual({ ...f.progress(session.id) }, progress)
})

test('retry deadline prevents even latest-sequence and metadata reads', async context => {
  const f = fixture(context)
  const session = f.create([{ assistantId: 5 }])
  context.mock.method(f.projection, 'ensure', async () => { throw new Error('temporary delivery failure') })
  await f.worker.syncPending()
  assert.equal(f.progress(session.id).attempts, 1)
  context.mock.method(f.sessions.events, 'latestSequence', () => { throw new Error('retry latest read') })
  context.mock.method(f.sessions, 'readMetadata', () => { throw new Error('retry metadata read') })
  await f.worker.syncPending()
  assert.equal(f.progress(session.id).attempts, 1)
})

test('changed destination starts its own progress without requiring a new local event', async context => {
  const f = fixture(context)
  const session = f.create([{ assistantId: 5 }])
  await f.worker.syncPending()
  const before = f.calls.length
  f.database.transaction(() => f.connections.saveInTransaction(session.id,
    { coreBaseUrl: 'http://127.0.0.1:2', coreToken: 'new-fixture-destination' }))
  await f.worker.syncPending()
  const rows = f.database.connection.prepare('SELECT after_seq FROM mon_sync_progress WHERE session_id=?').all(session.id)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.after_seq), ['1', '1'])
  assert.equal(f.calls.length, before * 2)
})

test('waiting configuration wakes after environment changes and a background round-trip', async context => {
  const f = fixture(context)
  const session = f.create([])
  const ensure = context.mock.method(f.projection, 'ensure')
  await f.worker.syncPending()
  assert.equal(ensure.mock.callCount(), 1)
  f.sessions.setMetadata(session.id, undefined, { sessionPurpose: 'self_awake' })
  await f.worker.syncPending()
  assert.equal(ensure.mock.callCount(), 1)
  f.sessions.setMetadata(session.id, undefined, { sessionPurpose: 'user_chat' })
  await f.worker.syncPending()
  assert.equal(ensure.mock.callCount(), 2)
  f.sessions.setMetadata(session.id, [{ assistantId: 5 }])
  await f.worker.syncPending()
  assert.equal(ensure.mock.callCount(), 3)
  assert.equal(f.progress(session.id).after_seq, '4')
})

test('idle scanning yields between sessions and close cancels the next slice without rejection', async context => {
  const f = fixture(context)
  for (let index = 0; index < 70; index++) f.create([{ assistantId: 5 }])
  await f.worker.syncPending()
  let examined = 0, whenYielded = 0
  const original = f.connections.readForSync.bind(f.connections)
  context.mock.method(f.connections, 'readForSync', (id: string) => {
    if (++examined === 1) setImmediate(() => { whenYielded = examined; void f.worker.close() })
    return original(id)
  })
  await f.worker.syncPending()
  assert.ok(whenYielded > 0 && whenYielded < 70)
  assert.ok(examined < 70)
})

test('background sessions wait for metadata changes without reloading unchanged event payloads', async context => {
  const f = fixture(context)
  const session = f.create([{ assistantId: 5 }])
  f.sessions.setMetadata(session.id, undefined, { subagent: true })
  await f.worker.syncPending()
  assert.equal(f.calls.length, 0)
  const metadata = context.mock.method(f.sessions, 'readMetadata')
  const batches = context.mock.method(f.sessions.events, 'projectionBatch')
  for (let index = 0; index < 3; index++) await f.worker.syncPending()
  assert.equal(metadata.mock.callCount(), 0)
  assert.equal(batches.mock.callCount(), 0)
  f.sessions.events.append(session.id, null, 'agent.message_update', {})
  await f.worker.syncPending()
  assert.equal(metadata.mock.callCount(), 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.progress(session.id).after_seq, '0')
  f.sessions.setMetadata(session.id, undefined, { subagent: false })
  await f.worker.syncPending()
  assert.equal(metadata.mock.callCount(), 1)
  assert.equal(f.calls.length, 2)
  assert.equal(f.progress(session.id).after_seq, '4')
})

test('corrupt metadata on a waiting session preserves its cursor without starving later sessions', async context => {
  const f = fixture(context)
  const [broken, healthy] = [f.create([]), f.create([])].sort((left, right) => left.id.localeCompare(right.id))
  await f.worker.syncPending()
  const bad = f.sessions.events.append(broken!.id, null, 'session.metadata.updated', {})
  f.database.connection.prepare('UPDATE events SET payload_json=? WHERE id=?').run('invalid metadata JSON', bad.id)
  f.sessions.setMetadata(healthy!.id, [{ assistantId: 5 }])
  await f.worker.syncPending()
  assert.equal(f.progress(broken!.id).after_seq, '0')
  assert.equal(f.progress(broken!.id).attempts, 1)
  assert.equal(f.progress(healthy!.id).after_seq, '2')
  assert.equal(f.progress(healthy!.id).attempts, 0)
  assert.equal(f.calls.length, 2)
})
