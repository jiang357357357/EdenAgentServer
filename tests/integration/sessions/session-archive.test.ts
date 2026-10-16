import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'

test('archive persists across restarts, keeps messages and queued work, and restores without closing the session', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eden-session-archive-')))
  const filename = path.join(root, 'session.sqlite')
  let database = new EdenDatabase(filename, 'local')
  t.after(async () => { database.close(); assert.ok(root.startsWith(await realpath(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }) })
  let repository = new SessionRepository(database, 'local')
  const session = repository.create('Keep this history')
  assert.equal(session.archived, false)
  repository.events.append(session.id, null, 'user.message', { text: 'retained history' })
  const inputs = new InputRepository(database, repository.events)
  const queued = inputs.enqueue(session.id, 'pending work', 'queued-before-archive')
  const events: string[] = []
  const unsubscribe = repository.events.subscribe(event => {
    if (event.kind === 'session.archive_updated') {
      assert.equal(repository.read(session.id).archived, (event.payload as { archived: boolean }).archived)
      events.push(event.kind)
    }
  })
  const archived = repository.setArchived(session.id, true)
  assert.equal(archived.archived, true); assert.equal(archived.status, 'active'); assert.equal(archived.executionStatus, 'busy')
  assert.equal(database.connection.prepare('SELECT state FROM inputs WHERE id=?').get(queued.inputId)?.state, 'queued')
  assert.equal(repository.setArchived(session.id, true).archived, true)
  assert.equal(events.length, 1)
  unsubscribe(); database.close()
  database = new EdenDatabase(filename, 'local'); repository = new SessionRepository(database, 'local')
  assert.equal(repository.read(session.id).archived, true)
  assert.ok(repository.events.list(session.id, '0', 100).some(event => event.kind === 'user.message'))
  assert.equal(repository.setArchived(session.id, false).archived, false)
  assert.equal(repository.read(session.id).status, 'active')
  assert.equal(database.connection.prepare('SELECT state FROM inputs WHERE id=?').get(queued.inputId)?.state, 'queued')
})

test('RPC lists filter archive before limiting, reject malformed updates, and keep archive separate from close/delete', async t => {
  const database = new EdenDatabase(':memory:', 'local'), repository = new SessionRepository(database, 'local')
  const service = new SessionService(repository, undefined)
  t.after(async () => { await service.close(); database.close() })
  const routes = sessionRoutes(service)
  const first = repository.create('First'), second = repository.create('Second')
  await routes['session.set_archived']!({ sessionId: second.id, archived: true })
  const normal = await routes['session.list']!({ limit: 1, archived: false }) as { id: string }[]
  assert.deepEqual(normal.map(item => item.id), [first.id])
  assert.deepEqual((await routes['session.list']!({ archived: true }) as { id: string }[]).map(item => item.id), [second.id])
  assert.equal((await routes['session.list']!({}) as unknown[]).length, 2)
  await assert.rejects(async () => routes['session.set_archived']!({ sessionId: first.id, archived: 'true' }))
  assert.equal(repository.read(first.id).archived, false)
  repository.setStatus(second.id, 'closed')
  assert.equal(repository.setArchived(second.id, false).status, 'closed')
  repository.setStatus(second.id, 'deleted')
  assert.throws(() => repository.setArchived(second.id, true), /not found/)
})

test('archived reads, writes and async lists retain current account and realm ownership', async t => {
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  t.after(() => database.close())
  const owner = { userId: '7', coreBaseUrl: 'https://core.example', key: accountKey('https://core.example', '7') }
  const other = { userId: '8', coreBaseUrl: 'https://core.example', key: accountKey('https://core.example', '8') }
  const session = withAccount(owner, () => repository.create('Owner conversation'))
  withAccount(owner, () => repository.setArchived(session.id, true))
  withAccount(other, () => assert.throws(() => repository.setArchived(session.id, false)))
  assert.deepEqual(await withAccount(other, () => repository.listAsync(100, true, true, undefined, undefined, undefined, true)), [])
  assert.equal((await withAccount(owner, () => repository.listAsync(100, true, true, undefined, undefined, undefined, true)))[0]?.id, session.id)
  const wrongRealm = new SessionRepository(database, 'local')
  withAccount(owner, () => assert.throws(() => wrongRealm.setArchived(session.id, false), /not found/))
  assert.equal(withAccount(owner, () => repository.read(session.id)).archived, true)
})
