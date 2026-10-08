import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { EdenDatabase } from '@eden/store'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import { configureLogging, loggingFile } from '../../../src/modules/logging/index.ts'
import { SharedFolderRegistry } from '../../../src/modules/shared-workspace/folder-registry.ts'
import { SharedWorkspaceService } from '../../../src/modules/shared-workspace/index.ts'
import type { SharedInstallation } from '../../../src/modules/shared-workspace/discovery.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { fakeSharedLanRuntime } from '../../helpers/shared-lan-runtime.ts'

class CountingRegistry extends SharedFolderRegistry {
  reads = 0
  override async read() { this.reads++; return super.read() }
}

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-optional-restore-')))
  const root = path.join(directory, 'project'), filename = path.join(directory, 'folders.json')
  mkdirSync(root)
  const database = new EdenDatabase(':memory:', 'mon'), workspace = new WorkspaceService(database, [], root)
  const coreBaseUrl = 'http://fixture.invalid', account = { coreBaseUrl, userId: '1', key: accountKey(coreBaseUrl, '1') }
  writeFileSync(filename, JSON.stringify({ version: 1, accountKey: account.key,
    folders: [{ root, kind: 'managed', workspaceKey: 'managed:default' }] }))
  const registry = new CountingRegistry(filename, account.key), counts = { requests: 0, loads: 0, starts: 0 }
  let installation: SharedInstallation = { entry: null, reason: '共享资料库 DLC 未安装或配置无效' }
  const logOptions = { origin: 'mon' as const, dataRoot: directory, env: { EDEN_AGENT_LOG_DIR: path.join(directory, 'logs'), EDEN_AGENT_LOG_FORMAT: 'json' } }
  const logging = configureLogging(logOptions)
  const service = new SharedWorkspaceService({ dataRoot: directory, workspace, account, registry,
    discover: () => installation, lan: fakeSharedLanRuntime(() => { counts.requests++ }),
    load: async () => { counts.loads++; return options => ({
      status: () => ({ root: options.workspace().root, bound: true, spaceId: 'fixture-space', paused: false,
        state: 'idle', pending: 0, conflicts: 0, lastSync: null, error: null }),
      bind: async () => {}, sync: async () => {}, pause: () => {}, files: () => [], conflicts: () => [],
      resolve: async () => {}, history: async () => ({}), restore: async () => {},
      start: () => { counts.starts++ }, suspend: async () => {}, close: async () => {},
    }) },
  })
  t.after(async () => { await service.close(); logging.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  const diagnostics = () => existsSync(loggingFile(logOptions))
    ? readFileSync(loggingFile(logOptions), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string }) : []
  return { service, registry, counts, diagnostics, root, filename,
    installation: (entry: string | null, reason: string | null = null) => { installation = { entry, reason } },
    attach: () => service.attach(async () => ({ accountKey: account.key, coreBaseUrl, token: 'fixture-only' })) }
}

for (const reason of ['共享资料库 DLC 未安装或配置无效', '共享资料库 DLC 尚未启用', '共享资料库 DLC 不兼容']) {
  test(`receiver background restoration remains available without publisher DLC: ${reason}`, async t => {
    const f = fixture(t)
    f.installation(null, reason)
    const persistent = f.attach()
    await assert.doesNotReject(f.service.backgroundReady())
    for (let index = 0; index < 6; index++) {
      const temporary = f.attach()
      await assert.doesNotReject(f.service.backgroundReady())
      temporary()
    }
    assert.ok(f.registry.reads > 0)
    assert.equal(f.counts.loads, 1)
    assert.ok(f.counts.starts > 0)
    assert.deepEqual(f.diagnostics(), [])
    const status = await f.service.status()
    assert.equal(status.available, true)
    assert.equal(status.canPublish, false)
    assert.equal(status.publishReason, reason)
    await assert.rejects(f.service.create(f.root, 'blocked'), error => error instanceof Error && error.message === reason)
    assert.equal(await f.service.perform(f.root, () => 'receiving remains available'), 'receiving remains available')
    persistent()
  })
}

test('enabling later restores registered folders without restarting the account runtime', async t => {
  const f = fixture(t)
  f.attach(); await assert.doesNotReject(f.service.backgroundReady())
  f.installation('/fixture/client.ts')
  f.attach(); await f.service.backgroundReady()
  assert.ok(f.registry.reads > 0)
  assert.equal(f.counts.loads, 1)
  assert.ok(f.counts.starts > 0)
  assert.deepEqual(f.service.folderFailures(), [])
  assert.deepEqual(f.diagnostics(), [])
})

test('disabling publication between attach and queued restoration does not stop receiver restoration', async t => {
  const f = fixture(t)
  f.installation('/fixture/client.ts')
  f.attach()
  f.installation(null, '共享资料库 DLC 尚未启用')
  await assert.doesNotReject(f.service.backgroundReady())
  assert.ok(f.registry.reads > 0)
  assert.equal(f.counts.loads, 1)
  assert.ok(f.counts.starts > 0)
  assert.deepEqual(f.diagnostics(), [])
})

test('an installed DLC with a corrupt folder registry still reports a genuine restoration error', async t => {
  const f = fixture(t)
  f.installation('/fixture/client.ts')
  writeFileSync(f.filename, '{invalid')
  f.attach()
  await assert.rejects(f.service.backgroundReady(), SyntaxError)
  assert.equal(f.registry.reads, 1)
  assert.deepEqual(f.diagnostics().map(record => record.event), ['shared_workspace.registry_restore_failed'])
})

test('corrupt registry retries back off across connections and recover automatically after repair', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const f = fixture(t), original = readFileSync(f.filename, 'utf8')
  writeFileSync(f.filename, '{invalid')
  const persistent = f.attach()
  await assert.rejects(f.service.backgroundReady(), SyntaxError)
  for (let index = 0; index < 6; index++) {
    const temporary = f.attach()
    await assert.rejects(f.service.backgroundReady(), SyntaxError)
    temporary()
  }
  assert.equal(f.registry.reads, 1)
  assert.equal(f.diagnostics().length, 1)
  assert.match((await f.service.status()).error!, /JSON/)
  t.mock.timers.tick(30_000); await setImmediate()
  await assert.rejects(f.service.backgroundReady(), SyntaxError)
  assert.equal(f.registry.reads, 2)
  assert.equal(f.diagnostics().length, 1)
  writeFileSync(f.filename, original)
  t.mock.timers.tick(59_999); await setImmediate()
  assert.equal(f.registry.reads, 2)
  t.mock.timers.tick(1); await setImmediate()
  await assert.doesNotReject(f.service.backgroundReady())
  // The recovered client also consults the registry when retaining its binding.
  assert.equal(f.registry.reads, 4)
  assert.equal((await f.service.status()).error, null)
  assert.ok(f.counts.starts > 0)
  persistent()
})

test('registry retry pauses without an authenticated lease and reports changed errors', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const f = fixture(t), original = readFileSync(f.filename, 'utf8')
  writeFileSync(f.filename, '{invalid')
  const detach = f.attach()
  await assert.rejects(f.service.backgroundReady(), SyntaxError)
  detach()
  t.mock.timers.tick(60_000); await setImmediate()
  assert.equal(f.registry.reads, 1)
  writeFileSync(f.filename, JSON.stringify({ ...JSON.parse(original), accountKey: 'other-account' }))
  f.attach()
  await assert.rejects(f.service.backgroundReady(), /其他账号/)
  assert.equal(f.registry.reads, 2)
  assert.equal(f.diagnostics().length, 2)
  await f.service.close()
  t.mock.timers.tick(600_000); await setImmediate()
  assert.equal(f.registry.reads, 2)
})

test('missing folder retries also back off and resume without reopening an unrelated workspace', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const f = fixture(t), moved = `${f.root}.moved`
  renameSync(f.root, moved)
  f.attach()
  await f.service.backgroundReady()
  for (let index = 0; index < 6; index++) {
    const temporary = f.attach()
    await f.service.backgroundReady()
    temporary()
  }
  assert.equal(f.service.folderFailures().length, 1)
  assert.deepEqual(f.diagnostics().map(record => record.event), ['shared_workspace.folder_restore_failed'])
  t.mock.timers.tick(30_000); await setImmediate()
  await f.service.backgroundReady()
  assert.equal(f.diagnostics().length, 1)
  renameSync(moved, f.root)
  t.mock.timers.tick(60_000); await setImmediate()
  await f.service.backgroundReady()
  assert.deepEqual(f.service.folderFailures(), [])
  assert.ok(f.counts.starts > 0)
})
