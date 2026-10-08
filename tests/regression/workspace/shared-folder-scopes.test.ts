import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { SharedWorkspaceService } from '../../../src/modules/shared-workspace/index.ts'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import type { SharedClient, SharedClientOptions } from '../../../src/modules/shared-workspace/contracts.ts'
import { fakeSharedLanRuntime } from '../../helpers/shared-lan-runtime.ts'

test('shared sync engines bind canonical folders, deduplicate explicit sharing and suspend every folder on logout', async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-shared-scopes-')))
  const aRoot = path.join(directory, 'first'), bRoot = path.join(directory, 'second')
  mkdirSync(aRoot); mkdirSync(bRoot)
  const database = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(database, 'mon')
  const workspace = new WorkspaceService(database, [], aRoot), a = sessions.create('A'), b = sessions.create('B')
  workspace.forSession(b.id).switch(bRoot)
  const loaded: SharedClientOptions[] = [], counts = { starts: 0, suspends: 0, closes: 0 }
  const coreBaseUrl = 'http://fixture.invalid', account = { coreBaseUrl, userId: '1', key: accountKey(coreBaseUrl, '1') }
  const service = new SharedWorkspaceService({ dataRoot: directory, workspace, account,
    discover: () => ({ entry: '/fixture/client.ts', reason: null }), lan: fakeSharedLanRuntime(),
    load: async () => options => {
      loaded.push(options)
      let spaceId: string | null = null
      const client: SharedClient = {
        status: () => ({ root: options.workspace().root, bound: spaceId !== null, spaceId, paused: false, state: 'idle', pending: 0,
          conflicts: 0, lastSync: null, error: null }),
        bind: async id => { spaceId = id }, sync: async () => {}, pause: () => {}, files: () => [], conflicts: () => [],
        resolve: async () => {}, history: async () => ({ versions: [] }), restore: async () => {},
        start: () => { counts.starts++ }, suspend: async () => { counts.suspends++ }, close: async () => { counts.closes++ },
      }
      return client
    },
  })
  try {
    const detach = service.attach(async () => ({ accountKey: account.key, coreBaseUrl, token: 'temporary-fixture-token' }))
    assert.equal(loaded.length, 0, 'Account credentials alone must not choose a global directory')
    service.selectDirectory(a.id, aRoot, '0')
    const first = service.forSession(a.id)
    assert.equal((await first.status()).root, aRoot)
    assert.equal(service.forSession(b.id), first, 'Different project workspaces do not select different shared directories')
    await first.perform(aRoot, client => client.bind('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
    service.selectDirectory(b.id, bRoot, service.directory(b.id).revision)
    const second = service.forSession(b.id)
    assert.equal((await second.status()).root, bRoot)
    assert.equal(loaded.length, 2)
    assert.equal((await second.status()).bound, false)
    workspace.forSession(a.id).switch(bRoot)
    assert.equal(service.forSession(a.id), second, 'The same selected folder has one engine, even across sessions')
    assert.equal(loaded[0]!.workspace().root, aRoot, 'Already bound background work retains its exact directory')
    assert.equal(loaded[1]!.workspace().root, bRoot)
    await assert.rejects(second.perform(aRoot, async () => {}), /已切换/)
    detach()
    let ran = false
    for (const options of loaded) await assert.rejects(options.mutate(options.workspace().root, async () => { ran = true }), /连接已关闭/)
    assert.equal(ran, false)
    assert.equal((await first.status()).available, false)
    assert.equal((await second.status()).available, false)
    await service.close()
    assert.equal(counts.closes, 2)
  } finally { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('navigation retires idle unbound folders while retaining active operations and bound background engines', async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-shared-navigation-')))
  const aRoot = path.join(directory, 'active'), bRoot = path.join(directory, 'bound')
  mkdirSync(aRoot); mkdirSync(bRoot)
  const database = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(database, 'mon')
  const workspace = new WorkspaceService(database, [], aRoot), a = sessions.create('A'), b = sessions.create('B')
  workspace.forSession(b.id).switch(bRoot)
  const alive = new Set<string>(), closed = new Set<string>()
  const coreBaseUrl = 'http://fixture.invalid', account = { coreBaseUrl, userId: '1', key: accountKey(coreBaseUrl, '1') }
  const service = new SharedWorkspaceService({ dataRoot: directory, workspace, account,
    discover: () => ({ entry: '/fixture/client.ts', reason: null }), lan: fakeSharedLanRuntime(),
    load: async () => options => {
      const root = options.workspace().root
      alive.add(root)
      let spaceId: string | null = null
      return {
        status: () => ({ root, bound: spaceId !== null, spaceId, paused: false, state: 'idle', pending: 0,
          conflicts: 0, lastSync: null, error: null }),
        bind: async id => { spaceId = id }, sync: async () => {}, pause: () => {}, files: () => [], conflicts: () => [],
        resolve: async () => {}, history: async () => ({ versions: [] }), restore: async () => {},
        start: () => {}, suspend: async () => {}, close: async () => { alive.delete(root); closed.add(root) },
      }
    },
  })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let pending: Promise<void> | undefined
  try {
    service.attach(async () => ({ accountKey: account.key, coreBaseUrl, token: 'temporary-fixture-token' }))
    service.selectDirectory(a.id, aRoot, '0')
    const active = service.forSession(a.id)
    await active.status()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    pending = active.perform(aRoot, async () => { entered(); await held })
    const rejected = assert.rejects(pending, /已切换/)
    await started
    service.selectDirectory(b.id, bRoot, service.directory(b.id).revision)
    const bound = service.forSession(b.id)
    await bound.perform(bRoot, client => client.bind('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
    for (let index = 0; index < 40; index++) {
      const root = path.join(directory, `navigation-${index}`)
      mkdirSync(root); service.selectDirectory(a.id, root, service.directory(a.id).revision)
      await service.forSession(a.id).status()
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(closed.size >= 8, 'Navigation must retire older idle unbound clients')
    assert.ok(alive.size <= 34, 'Retain at most 32 idle unbound clients plus the active and bound engines')
    assert.equal(closed.has(aRoot), false)
    assert.equal(closed.has(bRoot), false)
    release(); await rejected; pending = undefined
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(alive.size <= 33, 'Completing an operation allows idle cache cleanup')
    assert.equal(closed.has(bRoot), false)
    service.selectDirectory(b.id, bRoot, service.directory(b.id).revision)
    assert.equal(service.forSession(b.id), bound)
  } finally { release(); await pending?.catch(() => {}); await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) }
})
