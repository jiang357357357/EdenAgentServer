import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import { SharedWorkspaceService } from '../../../src/modules/shared-workspace/index.ts'
import type { SharedClient, SharedClientOptions, SharedCredential } from '../../../src/modules/shared-workspace/contracts.ts'
import { sharedWorkspaceRoutes } from '../../../src/transport/rpc/shared-workspace.routes.ts'
import { fakeSharedLanRuntime } from '../../helpers/shared-lan-runtime.ts'

function fixture(t: TestContext) {
  const base = 'http://127.0.0.1:12345'
  const account = { coreBaseUrl: base, userId: '1', key: accountKey(base, '1') }
  const credential: SharedCredential = { accountKey: account.key, coreBaseUrl: base, token: 'temporary-test-credential' }
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-shared-service-')))
  const root = path.join(directory, 'shared'), other = path.join(directory, 'other')
  mkdirSync(root); mkdirSync(other)
  let starts = 0, suspends = 0, closes = 0, mutations = 0, calls = 0
  let options: SharedClientOptions | undefined
  let spaceId: string | null = null
  let enabled = true
  const client: SharedClient = {
    status: () => ({ root, bound: spaceId !== null, spaceId, paused: false, state: 'idle', pending: 0,
      conflicts: 0, lastSync: null, error: null }),
    bind: async id => { spaceId = id }, sync: async () => {}, pause: () => {}, files: () => [], conflicts: () => [],
    resolve: async () => {}, history: async () => ({ versions: [] }), restore: async () => {},
    start: () => { starts++ }, suspend: async () => { suspends++ }, close: async () => { closes++ },
  }
  const pinned = {
    root: () => root, info: () => ({ name: 'test', path: root, kind: 'external' as const, status: 'ready' as const, defaultPath: null, error: null }),
    mutate: async <T>(_root: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> => { signal.throwIfAborted(); mutations++; return work() },
  }
  const service = new SharedWorkspaceService({ dataRoot: directory, account,
    lan: fakeSharedLanRuntime(() => { calls++ }),
    workspace: { ...pinned, restorePinned: selection => ({ ...pinned, root: () => selection.root,
      info: () => ({ ...pinned.info(), path: selection.root }) }) },
    discover: () => ({ entry: enabled ? '/fixture/client.ts' : null, reason: enabled ? null : 'DLC disabled' }),
    load: async () => input => { options = input; return client },
  })
  service.selectDirectory('fixture', root, '0')
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }) })
  return { service, credential, account, client, root, other, options: () => options!, counts: () => ({ starts, suspends, closes, mutations, calls }),
    enabled: (value: boolean) => { enabled = value },
    select: (next: string) => service.selectDirectory('fixture', next, service.directory('fixture').revision) }
}

test('shared workspace leases start once authenticated, last detach suspends, and reconnect resumes', async t => {
  const f = fixture(t)
  const first = f.service.attach(async () => f.credential)
  const second = f.service.attach(async () => f.credential)
  assert.equal((await f.service.status()).available, true)
  await setImmediate()
  first(); await setImmediate()
  assert.equal(f.counts().suspends, 0)
  second(); await setImmediate()
  assert.equal(f.counts().suspends, 1)
  assert.equal((await f.service.status()).available, false)
  const reconnect = f.service.attach(async () => f.credential)
  await f.service.status(); await setImmediate()
  assert.equal(f.counts().calls, 1)
  assert.ok(f.counts().starts >= 2)
  reconnect()
  await f.service.close()
  assert.equal(f.counts().closes, 1)
})

test('same user on another Core cannot lend credentials or make requests', async t => {
  const f = fixture(t)
  f.service.attach(async () => ({ ...f.credential, coreBaseUrl: 'http://127.0.0.1:54321' }))
  const status = await f.service.status()
  assert.equal(status.available, false)
  assert.match(status.reason!, /身份不匹配/)
  assert.equal(f.counts().calls, 0)
})

test('a shared engine remains pinned to its own canonical directory after shared selection changes', async t => {
  const f = fixture(t)
  f.service.attach(async () => f.credential)
  await f.service.status()
  assert.deepEqual(f.options().workspace(), { root: f.root, key: `external:${f.root}` })
  f.select(f.other)
  assert.deepEqual(f.options().workspace(), { root: f.root, key: `external:${f.root}` })
})

test('inbound engine writes pass through workspace mutation and detach blocks further writes', async t => {
  const f = fixture(t)
  const detach = f.service.attach(async () => f.credential)
  await f.service.status()
  let writes = 0
  await f.options().mutate(f.root, async () => { writes++ })
  assert.equal(f.counts().mutations, 1)
  detach()
  await assert.rejects(f.options().mutate(f.root, async () => { writes++ }), /连接已关闭/)
  assert.equal(writes, 1)
})

test('RPC binds only the confirmed independent shared directory and rejects stale shared scope', async t => {
  const f = fixture(t)
  f.service.attach(async () => f.credential)
  const routes = sharedWorkspaceRoutes(f.service)
  const input = { sessionId: '11111111-1111-4111-8111-111111111111', spaceId: '33333333-3333-4333-8333-333333333333', expectedWorkspacePath: f.root }
  await assert.rejects(routes['sharedWorkspace.bind'](input))
  const result = await routes['sharedWorkspace.bind']({ ...input, confirmShare: true }) as { bound: boolean }
  assert.equal(result.bound, true)
  f.select(f.other)
  await assert.rejects(routes['sharedWorkspace.sync']({ sessionId: input.sessionId, expectedWorkspacePath: input.expectedWorkspacePath }), /已切换/)
  await assert.rejects(routes['sharedWorkspace.members']({ expectedWorkspacePath: '/other/workspace', action: 'set' }))
})

test('local realm without a Core account exposes unavailable status without loading or authenticating', async () => {
  let loaded = 0
  const service = new SharedWorkspaceService({ dataRoot: '/unused', account: undefined,
    workspace: { root: () => '/unused', info: () => ({ name: '', path: '', kind: 'none', status: 'unselected', defaultPath: null, error: null }),
      mutate: async (_root, _signal, work) => work() },
    load: async () => { loaded++; throw new Error('must not load') },
  })
  assert.equal((await service.status()).available, false)
  await assert.rejects(service.perform('/unused', () => undefined), /登录伊甸园/)
  assert.equal(loaded, 0)
  await service.close()
})

test('publisher DLC is optional for reception and disabling it keeps local pairing and workspace writes available', async t => {
  const f = fixture(t)
  f.service.attach(async () => f.credential)
  await f.service.status(); await setImmediate()
  f.enabled(false)
  await assert.doesNotReject(f.options().remote.request('GET', 'spaces'))
  await assert.doesNotReject(f.options().mutate(f.root, async () => {}))
  const receiving = await f.service.status()
  assert.equal(receiving.available, true)
  assert.equal(receiving.canPublish, false)
  await assert.rejects(f.service.create(f.root, 'blocked'), /disabled/)
  await setImmediate()
  assert.equal(f.counts().suspends, 0)
  const starts = f.counts().starts
  f.enabled(true)
  assert.equal((await f.service.status()).canPublish, true)
  assert.equal(f.counts().starts, starts)
  await f.options().mutate(f.root, async () => {})
})
