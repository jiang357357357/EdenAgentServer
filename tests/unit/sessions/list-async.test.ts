import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { getEventListeners } from 'node:events'
import { EdenDatabase } from '@eden/store'
import { rpcMethods } from '@eden/api'
import type { SessionPurpose, SessionSourceChannel } from '@eden/api'
import { SessionRepository, type SessionService } from '../../../src/modules/sessions/index.ts'
import { accountKey, currentAccount, withAccount, type Account } from '../../../src/modules/accounts/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  const repository = new SessionRepository(database, 'mon')
  t.after(() => database.close())
  return { database, repository }
}
function account(userId: string): Account {
  const coreBaseUrl = 'http://session-list.invalid'
  return { coreBaseUrl, userId, key: accountKey(coreBaseUrl, userId) }
}
function populate(repository: SessionRepository, count: number) {
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    const session = repository.create(`Synthetic ${index}`, [{ assistantId: 1 }])
    repository.database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(index, session.id)
    ids.push(session.id)
  }
  return ids
}

test('async listing preserves synchronous classification filters, status, origin, ordering and limits', async t => {
  const { repository, database } = fixture(t)
  const variants: [SessionPurpose, SessionSourceChannel, string][] = [
    ['user_chat', 'app', 'active'], ['user_chat', 'app', 'closed'], ['user_chat', 'qq', 'active'],
    ['self_awake', 'internal', 'active'], ['subagent', 'internal', 'closed'], ['user_chat', 'app', 'deleted'],
  ]
  for (const [index, [purpose, sourceChannel, status]] of variants.entries()) {
    const session = repository.create(`Kind ${index}`, [{ assistantId: 1 }], null, { purpose, sourceChannel })
    database.connection.prepare('UPDATE sessions SET updated_at=?,status=? WHERE id=?').run(index + 1, status, session.id)
  }
  const otherRealm = repository.create('Other realm')
  database.connection.prepare("UPDATE sessions SET origin='local',updated_at=99 WHERE id=?").run(otherRealm.id)
  const filters: Parameters<SessionRepository['list']>[] = [
    [], [1], [100, true], [100, false, false], [100, true, false],
    [100, true, false, 'self_awake'], [100, true, false, undefined, 'qq'],
    [100, true, true, 'subagent', 'internal'], [100, false, true, 'subagent'], [0],
  ]
  for (const args of filters) assert.deepEqual(await repository.listAsync(args[0], args[1], args[2], args[3], args[4], undefined, args[5]), repository.list(...args))
  assert.deepEqual((await repository.listAsync(100, false, false)).map(session => session.title), ['Kind 0'])
  assert.deepEqual((await repository.listAsync(100, true, true)).map(session => session.title), ['Kind 4', 'Kind 3', 'Kind 2', 'Kind 1', 'Kind 0'])
})

test('concurrent account lists preserve AsyncLocalStorage ownership across every yield', async t => {
  const { repository } = fixture(t)
  const first = account('first'), second = account('second')
  const a = withAccount(first, () => populate(repository, 80))
  const b = withAccount(second, () => populate(repository, 80))
  repository.create('Unowned internal fixture')
  const original = repository.read.bind(repository)
  const owners = new Map([...a.map(id => [id, first.key] as const), ...b.map(id => [id, second.key] as const)])
  t.mock.method(repository, 'read', (id: string) => {
    assert.equal(currentAccount()?.key, owners.get(id))
    return original(id)
  })
  const [left, right] = await Promise.all([
    withAccount(first, () => repository.listAsync()), withAccount(second, () => repository.listAsync()),
  ])
  assert.deepEqual(left.map(session => session.id), a.toReversed())
  assert.deepEqual(right.map(session => session.id), b.toReversed())
})

test('an ownership revocation between batches rejects the whole list', async t => {
  const { repository, database } = fixture(t)
  const owner = account('owner'), stranger = account('stranger')
  const ids = withAccount(owner, () => populate(repository, 80))
  const original = repository.read.bind(repository)
  let reads = 0
  t.mock.method(repository, 'read', (id: string) => {
    if (++reads === 1) setImmediate(() => database.connection.prepare('UPDATE session_owners SET account_key=? WHERE session_id=?').run(stranger.key, ids[0]!))
    return original(id)
  })
  await assert.rejects(withAccount(owner, () => repository.listAsync()), /不属于当前账号/)
  assert.equal(reads, 80)
})

test('a session deleted between batches fails explicitly instead of returning a partial list', async t => {
  const { repository, database } = fixture(t)
  const ids = populate(repository, 80)
  const original = repository.read.bind(repository)
  let scheduled = false
  t.mock.method(repository, 'read', (id: string) => {
    if (!scheduled) {
      scheduled = true
      setImmediate(() => database.connection.prepare("UPDATE sessions SET status='deleted' WHERE id=?").run(ids[0]!))
    }
    return original(id)
  })
  await assert.rejects(repository.listAsync(), /Session not found/)
})

test('connection cancellation stops remaining batches and removes AbortSignal listeners', async t => {
  const { repository } = fixture(t)
  populate(repository, 80)
  const controller = new AbortController()
  const original = repository.read.bind(repository)
  let reads = 0
  t.mock.method(repository, 'read', (id: string) => {
    if (++reads === 1) setImmediate(() => controller.abort())
    return original(id)
  })
  await assert.rejects(repository.listAsync(100, false, true, undefined, undefined, controller.signal), { name: 'AbortError' })
  assert.ok(reads > 0 && reads < 80)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const stoppedAt = reads
  await assert.rejects(repository.listAsync(100, false, true, undefined, undefined, controller.signal), { name: 'AbortError' })
  assert.equal(reads, stoppedAt)
  const active = new AbortController()
  assert.equal((await repository.listAsync(100, false, true, undefined, undefined, active.signal)).length, 80)
  assert.equal(getEventListeners(active.signal, 'abort').length, 0)
})

test('session.list RPC awaits the async repository, preserves its schema and forwards lifetime cancellation', async t => {
  const { repository } = fixture(t)
  const ids = populate(repository, 3)
  const controller = new AbortController()
  const original = repository.listAsync.bind(repository)
  let parameters: Parameters<SessionRepository['listAsync']> | undefined
  t.mock.method(repository, 'listAsync', (...args: Parameters<SessionRepository['listAsync']>) => {
    parameters = args
    return original(...args)
  })
  t.mock.method(repository, 'list', () => { throw new Error('The RPC must not run the synchronous list path') })
  const service = { repository, isRunning: (id: string) => id === ids[2] } as SessionService
  const routes = sessionRoutes(service, controller.signal)
  const result = rpcMethods['session.list'].result.parse(await routes['session.list']!({ limit: 2 }))
  assert.deepEqual(result.map(session => session.id), ids.toReversed().slice(0, 2))
  assert.deepEqual(result.map(session => session.executionStatus), ['busy', 'idle'])
  assert.deepEqual(parameters, [2, false, false, undefined, undefined, controller.signal, undefined])
  await assert.rejects(Promise.resolve(routes['session.list']!({ limit: 1001 })))
  controller.abort()
  await assert.rejects(Promise.resolve(routes['session.list']!({ limit: 2 })), { name: 'AbortError' })
})
