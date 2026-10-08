import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { MonClient, MonHttpError } from '@eden/integrations'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { MonSessionProjection } from '../../../src/modules/mon/session-projection.ts'
import { MonSyncWorker } from '../../../src/modules/mon/sync-worker.ts'
import { resumeProjection } from '../../../src/modules/mon/projection-recovery.ts'
import { destinationDigest, monDestination } from '../../../src/modules/mon/destination.ts'
import { MonSyncStatus } from '../../../src/modules/mon/sync-status.ts'
import type { JsonValue } from '@eden/api'

function fixture(t: import('node:test').TestContext) {
  const db = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(db, 'mon'), connections = new MonConnectionRepository(db)
  const session = sessions.create('bounded', [{ assistantId: 5 }])
  const connection = { coreBaseUrl: 'http://127.0.0.1:1', coreToken: 'first' }
  db.transaction(() => connections.saveInTransaction(session.id, connection))
  const worker = new MonSyncWorker(sessions, connections, new MonSessionProjection(sessions))
  t.after(async () => { await worker.close(); db.close() })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network') })
  t.mock.method(MonClient.prototype, 'put', async () => ({}))
  return { db, sessions, connections, session, worker, connection,
    progress: () => db.connection.prepare('SELECT * FROM mon_sync_progress WHERE session_id=?').get(session.id)! }
}
test('permanent rejection pauses once, keeps original evidence and resumes only by explicit request', async t => {
  const f = fixture(t); let rejected = true, calls = 0
  t.mock.method(MonClient.prototype, 'post', async (path: string) => {
    calls++; if (rejected) throw new MonHttpError(400, path, { assistant: ['not an enabled participant'] }); return { id: 17 }
  })
  await f.worker.syncPending()
  for (let index = 0; index < 20; index++) await f.worker.syncPending()
  assert.equal(calls, 1); assert.equal(f.progress().retry_at, -1); assert.equal(f.progress().after_seq, '0')
  const status = new MonSyncStatus(f.sessions).read({ sessionId: f.session.id })
  assert.equal(status.totals.failed, 1); assert.match(status.items[0]!.error!, /enabled participant/)
  rejected = false
  assert.equal(resumeProjection(f.sessions, f.connections, f.session.id).resumed, true)
  await f.worker.syncPending(); assert.equal(calls, 2); assert.equal(f.progress().error, null)
  assert.equal(f.sessions.events.list(f.session.id).filter(event => event.kind === 'mon.sync.resumed').length, 1)
})
test('unconfirmed outcomes and repeated 503 stop after eight attempts, including after worker restart', async t => {
  const f = fixture(t); let calls = 0
  t.mock.method(MonClient.prototype, 'post', async () => { calls++; throw new MonHttpError(503, '/api/agent/sessions/') })
  for (let index = 0; index < 8; index++) {
    f.db.connection.prepare('UPDATE mon_sync_progress SET retry_at=0 WHERE retry_at>=0').run()
    await f.worker.syncPending()
  }
  assert.equal(calls, 8); assert.equal(f.progress().retry_at, -1)
  const restarted = new MonSyncWorker(f.sessions, f.connections, new MonSessionProjection(f.sessions))
  try { for (let index = 0; index < 10; index++) await restarted.syncPending() } finally { await restarted.close() }
  assert.equal(calls, 8)
  assert.equal(f.db.connection.prepare('SELECT state FROM mon_projection_outbox').get()!.state, 'unknown')
  assert.equal(f.sessions.events.list(f.session.id).filter(event => event.kind === 'mon.sync.paused').length, 1)
})
test('credential rotation preserves progress and exact legacy receipts; changing Core starts another destination', async t => {
  const f = fixture(t); let messages = 0
  t.mock.method(MonClient.prototype, 'post', async (path: string) => { if (path.endsWith('/messages/')) messages++; return path === '/api/agent/sessions/' ? { id: 17 } : { sync_status: 'synced' } })
  const event = f.sessions.events.append(f.session.id, null, 'agent.message_end', { messageId: 'one', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } })
  await f.worker.syncPending(); assert.equal(messages, 1)
  const key = destinationDigest(monDestination(f.connection)), old = destinationDigest(JSON.stringify(f.connection))
  f.db.connection.prepare('UPDATE mon_sync_progress SET destination_key=? WHERE destination_key=?').run(old, key)
  f.db.connection.prepare('UPDATE mon_projection_outbox SET destination_key=? WHERE destination_key=?').run(old, key)
  await f.worker.syncPending()
  f.db.transaction(() => f.connections.saveInTransaction(f.session.id, { ...f.connection, coreToken: 'renewed' }))
  await f.worker.syncPending(); assert.equal(messages, 1); assert.equal(f.progress().after_seq, event.seq)
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM mon_sync_progress').get()!.n, 1)
  f.db.transaction(() => f.connections.saveInTransaction(f.session.id, { ...f.connection, coreBaseUrl: 'http://127.0.0.1:2' }))
  await f.worker.syncPending(); assert.equal(messages, 2)
})
test('direct speech projection obeys the durable attempt budget without a sync worker', async t => {
  const f = fixture(t); const projection = new MonSessionProjection(f.sessions), client = new MonClient(f.connection.coreBaseUrl, 'first')
  let calls = 0
  t.mock.method(MonClient.prototype, 'post', async () => { calls++; throw new Error('response lost') })
  for (let index = 0; index < 12; index++) await assert.rejects(projection.ensure(client, f.session.id, monDestination(f.connection), new AbortController().signal))
  assert.equal(calls, 8)
})
