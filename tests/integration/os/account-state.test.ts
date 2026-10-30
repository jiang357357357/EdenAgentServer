import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { osFixture } from '../../helpers/os-config.ts'
import { migrateOsAccountState } from '../../../src/bootstrap/os-account-state.ts'
import { saveState, readState } from '../../../src/modules/os/state-store.ts'

test('verified legacy ownership copies the clock once; another service binding never adopts its private plans', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-os-account-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const legacy = path.join(root, 'legacy-wake'), config = osFixture(root)
  config.identity = { userId: '2', coreBaseUrl: 'http://127.0.0.1:1', secret: 'isolated' }
  config.legacyWakeDir = legacy; config.wakeDir = path.join(legacy, 'accounts', 'owner')
  saveState(path.join(legacy, 'role-coordinator.json'), { schema_version: 'self-awake.roles.v1', user_id: '2' })
  saveState(path.join(legacy, 'state.json'), { enabled: true, next_wake_reason: '原账号的计划' })
  const original = readFileSync(path.join(legacy, 'state.json'))
  migrateOsAccountState(config)
  assert.equal(readState(path.join(config.wakeDir, 'state.json')).next_wake_reason, '原账号的计划')
  assert.equal(readState(path.join(config.wakeDir, 'ownership.json')).legacyStateCopied, true)
  saveState(path.join(config.wakeDir, 'state.json'), { next_wake_reason: '新时钟' })
  migrateOsAccountState(config)
  assert.equal(readState(path.join(config.wakeDir, 'state.json')).next_wake_reason, '新时钟')
  config.identity.userId = '3'; config.wakeDir = path.join(legacy, 'accounts', 'other')
  migrateOsAccountState(config)
  assert.equal(existsSync(path.join(config.wakeDir, 'state.json')), false)
  assert.equal(readState(path.join(config.wakeDir, 'ownership.json')).legacyStateCopied, false)
  assert.deepEqual(readFileSync(path.join(legacy, 'state.json')), original)
})
