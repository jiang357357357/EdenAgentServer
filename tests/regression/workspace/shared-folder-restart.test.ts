import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { SharedWorkspaceService } from '../../../src/modules/shared-workspace/index.ts'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import type { SharedClientFactory } from '../../../src/modules/shared-workspace/contracts.ts'
import { fakeSharedLanRuntime } from '../../helpers/shared-lan-runtime.ts'

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-shared-restart-')))
  const dataRoot = path.join(directory, 'private'), original = path.join(directory, '原始 包', 'project'), external = path.join(directory, 'external')
  mkdirSync(original, { recursive: true }); mkdirSync(external)
  const database = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(database, 'mon')
  const a = sessions.create('A'), b = sessions.create('B')
  const coreBaseUrl = 'http://fixture.invalid', account = { coreBaseUrl, userId: '1', key: accountKey(coreBaseUrl, '1') }
  // The DLC's durable bindings are independent of host instances; the host must restore their keys unchanged.
  const bindings = new Map<string, string>(), starts = new Set<string>(), opened = new Set<string>()
  const factory: SharedClientFactory = options => {
    const scope = options.workspace()
    opened.add(scope.root)
    return {
      status: () => ({ root: scope.root, bound: bindings.has(scope.key), spaceId: bindings.get(scope.key) ?? null,
        paused: false, state: 'idle', pending: 0, conflicts: 0, lastSync: null, error: null }),
      bind: async spaceId => { bindings.set(scope.key, spaceId) }, sync: async () => {}, pause: () => {}, files: () => [], conflicts: () => [],
      resolve: async () => {}, history: async () => ({ versions: [] }), restore: async () => {},
      start: () => { starts.add(scope.root) }, suspend: async () => {}, close: async () => {},
    }
  }
  const hosts: SharedWorkspaceService[] = []
  function host(root = original) {
    const workspace = new WorkspaceService(database, [], root)
    const service = new SharedWorkspaceService({ dataRoot, workspace, account,
      discover: () => ({ entry: '/fixture/client.ts', reason: null }), lan: fakeSharedLanRuntime(), load: async () => factory,
    })
    hosts.push(service)
    return { workspace, service }
  }
  function attach(service: SharedWorkspaceService) {
    service.attach(async () => ({ accountKey: account.key, coreBaseUrl, token: 'temporary-fixture-token' }))
    return service.backgroundReady()
  }
  t.after(async () => { await Promise.all(hosts.map(service => service.close())); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, dataRoot, original, external, a, b, account, bindings, starts, opened, host, attach }
}

test('restart resumes registered shared directories at their recorded roots regardless of current project relocation', async t => {
  const f = fixture(t), first = f.host()
  first.workspace.forSession(f.b.id).switch(f.external)
  await f.attach(first.service)
  first.service.selectDirectory(f.a.id, f.original, '0')
  await first.service.forSession(f.a.id).perform(f.original, client => client.bind('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
  first.service.selectDirectory(f.b.id, f.external, first.service.directory(f.b.id).revision)
  await first.service.forSession(f.b.id).perform(f.external, client => client.bind('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
  const registryPath = path.join(f.dataRoot, 'shared-workspace-lan', 'folders.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  assert.deepEqual(registry.folders.map((folder: { workspaceKey: string }) => folder.workspaceKey).sort(), [`external:${f.external}`, `external:${f.original}`].sort())
  assert.equal(readFileSync(registryPath, 'utf8').includes('token'), false)
  await first.service.close()
  const moved = path.join(f.directory, '移动后 中文包', 'project')
  mkdirSync(moved, { recursive: true })
  f.starts.clear(); f.opened.clear()
  const second = f.host(moved)
  await f.attach(second.service)
  assert.deepEqual([...f.starts].sort(), [f.original, f.external].sort(), 'Moving the project never redirects independent shared folders')
  assert.equal(second.service.directory(f.a.id).path, f.external)
  assert.deepEqual(second.service.folderFailures(), [])
  assert.equal(f.bindings.size, 2, 'Restore preserves existing stable DLC binding keys')
  assert.ok(JSON.parse(readFileSync(registryPath, 'utf8')).folders.some((folder: { root: string }) => folder.root === f.original))
  await second.service.close()
  rmSync(f.external, { recursive: true })
  f.starts.clear(); f.opened.clear()
  const third = f.host(moved)
  await f.attach(third.service)
  assert.deepEqual([...f.starts], [f.original], 'One missing folder cannot prevent another independent folder resuming')
  assert.deepEqual([...f.opened], [f.original], 'No client opens on a missing or substitute directory')
  assert.equal(third.service.folderFailures()[0]?.root, f.external)
  assert.match(third.service.folderFailures()[0]?.error ?? '', /missing/)
  assert.ok(JSON.parse(readFileSync(registryPath, 'utf8')).folders.some((folder: { root: string }) => folder.root === f.external), 'Missing directory registration is retained for recovery')
})

test('a registered legacy default binding seeds the independent selection without changing its root or key', async t => {
  const f = fixture(t)
  f.bindings.set('managed:default', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  mkdirSync(path.join(f.dataRoot, 'shared-workspace-lan'), { recursive: true })
  writeFileSync(path.join(f.dataRoot, 'shared-workspace-lan', 'folders.json'), JSON.stringify({ version: 1, accountKey: f.account.key,
    folders: [{ root: f.original, kind: 'managed', workspaceKey: 'managed:default' }] }))
  const { service } = f.host()
  await f.attach(service)
  assert.deepEqual([...f.starts], [f.original])
  const saved = JSON.parse(readFileSync(path.join(f.dataRoot, 'shared-workspace-lan', 'folders.json'), 'utf8'))
  assert.equal(saved.folders.length, 1)
  assert.equal(saved.folders[0].workspaceKey, 'managed:default')
  assert.equal(service.directory(f.a.id).path, f.original)
})

test('no shared registration never adopts a current workspace or a legacy guessed default key', async t => {
  const f = fixture(t), { service } = f.host()
  f.bindings.set('managed:default', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  await f.attach(service)
  assert.deepEqual([...f.starts], []); assert.deepEqual([...f.opened], [])
  assert.equal(service.directory(f.a.id).status, 'unselected')
})
