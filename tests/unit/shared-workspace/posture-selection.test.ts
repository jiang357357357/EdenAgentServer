import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SharedPostureSelection } from '../../../src/modules/shared-workspace/posture-selection.ts'
import { SharedPostureDirectories } from '../../../src/modules/shared-workspace/posture-directories.ts'

test('posture selection locks exactly one mode, survives restart, and rejects stale or foreign account writes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-posture-store-')), file = path.join(root, 'posture.json')
  try {
    const store = new SharedPostureSelection(file, 'account-one')
    const cloud = store.select('cloud', store.read().revision)
    assert.deepEqual(store.select('cloud', cloud.revision), cloud)
    assert.deepEqual(new SharedPostureSelection(file, 'account-one').read(), cloud)
    assert.throws(() => store.select('lan', '0'), /其他窗口/)
    assert.throws(() => new SharedPostureSelection(file, 'account-two').read(), /其他账号/)
    assert.equal(store.select('lan', cloud.revision).mode, 'lan')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('each posture remembers its own directory and switching invalidates an earlier directory decision', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-posture-dirs-'))
  const lan = path.join(root, 'lan-files'), cloud = path.join(root, 'cloud-files')
  mkdirSync(lan); mkdirSync(cloud)
  try {
    const posture = new SharedPostureSelection(path.join(root, 'posture.json'), 'account')
    const directories = new SharedPostureDirectories(root, 'account', posture)
    const selectedLan = directories.select(lan, directories.read().revision)
    posture.select('cloud', posture.read().revision)
    assert.equal(directories.read().path, '')
    assert.throws(() => directories.select(cloud, selectedLan.revision), /目录或姿态已改变/)
    directories.select(cloud, directories.read().revision)
    posture.select('lan', posture.read().revision)
    assert.equal(directories.read().path, selectedLan.path)
    assert.throws(() => directories.assert(selectedLan), /目录或姿态/)
    posture.select('cloud', posture.read().revision)
    assert.equal(directories.read().path, path.resolve(cloud))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
