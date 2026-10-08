import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverSharedWorkspace } from '../../../src/modules/shared-workspace/discovery.ts'
import { deviceIdentity } from '../../../src/modules/shared-workspace/device.ts'

async function fixture(t: TestContext, portable = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-shared-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mon = portable ? path.join(root, '便携包 中文', 'EDEN_win') : path.join(root, '中文 工作区')
  const dlc = portable ? path.join(path.dirname(mon), 'SharedWorkspace') : path.join(mon, 'DLC', 'SharedWorkspace')
  await mkdir(path.join(dlc, 'client'), { recursive: true })
  await mkdir(path.join(mon, '.run', 'dlc'), { recursive: true })
  await writeFile(path.join(mon, '.monworkspace'), '{}')
  await writeFile(path.join(mon, '.monconfig'), '{}')
  await writeFile(path.join(dlc, 'dlc-manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'shared-workspace',
    publisher: { capability: 'workspace.publish.v2' }, capabilities: ['workspace.publish.v2'], transport: 'lan', protocolVersion: 2 }))
  const enabled = (value: boolean) => writeFile(path.join(mon, '.run', 'dlc', 'state.json'), JSON.stringify({ enabled: { 'shared-workspace': value } }))
  await enabled(true)
  return { root, mon, dlc, enabled }
}

test('source and portable DLC discovery require explicit enablement and capability', async t => {
  const f = await fixture(t)
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, path.join(f.dlc, 'dlc-manifest.json'))
  await f.enabled(false)
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, null)
  await f.enabled(true)
  await writeFile(path.join(f.dlc, 'dlc-manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'shared-workspace' }))
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, null)
  const portable = await fixture(t, true)
  assert.equal(discoverSharedWorkspace([portable.mon], '').entry, path.join(portable.dlc, 'dlc-manifest.json'))
})

test('directory relocation discovers new artifact path with old path absent', async t => {
  const f = await fixture(t)
  const moved = path.join(f.root, '移动后 中文')
  await rename(f.mon, moved)
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, null)
  assert.equal(discoverSharedWorkspace([moved], '').entry, path.join(moved, 'DLC', 'SharedWorkspace', 'dlc-manifest.json'))
})

test('absent enablement configuration leaves the optional DLC disabled without reporting an invalid installation', async t => {
  const f = await fixture(t)
  await rm(path.join(f.mon, '.run', 'dlc', 'state.json'))
  assert.deepEqual(discoverSharedWorkspace([f.mon], ''), { entry: null, reason: '共享资料库 DLC 尚未启用' })
  await writeFile(path.join(f.mon, '.run', 'dlc', 'state.json'), '{invalid')
  assert.deepEqual(discoverSharedWorkspace([f.mon], ''), { entry: null, reason: '共享资料库 DLC 未安装或配置无效' })
})

test('sibling DLC moves with the portable bundle and only the main workspace controls enablement', async t => {
  const f = await fixture(t, true)
  await mkdir(path.join(f.dlc, '.run', 'dlc'), { recursive: true })
  await writeFile(path.join(f.dlc, '.run', 'dlc', 'state.json'), '{"enabled":{"shared-workspace":true}}')
  await f.enabled(false)
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, null)
  await f.enabled(true)
  await writeFile(path.join(f.dlc, '.run', 'dlc', 'state.json'), '{"enabled":{"shared-workspace":false}}')
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, path.join(f.dlc, 'dlc-manifest.json'))
  const moved = path.join(f.root, '移动后 便携包')
  await rename(path.dirname(f.mon), moved)
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, null)
  assert.equal(discoverSharedWorkspace([path.join(moved, 'EDEN_win')], '').entry,
    path.join(moved, 'SharedWorkspace', 'dlc-manifest.json'))
})

test('DLC module manifest alone cannot shadow the parent Mon workspace anchor', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.dlc, '.monworkspace'), '{"modules":[]}')
  assert.equal(discoverSharedWorkspace([path.join(f.dlc, 'client')], '').entry, path.join(f.dlc, 'dlc-manifest.json'))
})

test('DLC junction cannot redirect the entire trusted module directory', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside')
  await rename(f.dlc, outside)
  try { await symlink(outside, f.dlc, 'junction') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('junction creation unavailable'); return }
    throw error
  }
  assert.equal(discoverSharedWorkspace([f.mon], '').entry, null)
})

test('device identity persists per local account and a fresh install gets a distinct identity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-shared-device-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = deviceIdentity(path.join(root, 'one'))
  const id = await first()
  assert.equal(await first(), id)
  assert.equal(await deviceIdentity(path.join(root, 'one'))(), id)
  assert.notEqual(await deviceIdentity(path.join(root, 'two'))(), id)
  await writeFile(path.join(root, 'two', 'device-id'), 'malformed')
  await assert.rejects(deviceIdentity(path.join(root, 'two'))(), /身份文件无效/)
})
