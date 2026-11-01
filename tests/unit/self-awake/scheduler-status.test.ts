import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/index.ts'
import { schedulerStatus } from '../../../src/modules/self-awake/scheduler-status.ts'
import { assertScopedScheduler } from '../../../src/modules/self-awake/scope-paths.ts'

test('missing, expired, malformed, incompatible and foreign-account leases have distinct actionable diagnoses', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-wake-diagnostic-')), stateFile = path.join(root, 'state.json')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'session-protocol.json')
  const valid = { protocolVersion: 2, sessionScopes: true, roleScopes: true, expiresAt: Date.now() + 30000 }
  assert.equal(schedulerStatus(undefined, true).status, 'unconfigured')
  assert.equal(schedulerStatus(undefined, false).status, 'internal')
  assert.equal(schedulerStatus(stateFile, true).status, 'unavailable')
  writeFileSync(file, JSON.stringify({ ...valid, expiresAt: Date.now() - 1 }))
  assert.equal(schedulerStatus(stateFile, true).status, 'expired')
  assert.throws(() => assertScopedScheduler(stateFile), /心跳已过期/)
  writeFileSync(file, '{'); assert.equal(schedulerStatus(stateFile, true).status, 'incompatible')
  writeFileSync(file, JSON.stringify({ ...valid, roleScopes: false }))
  assert.equal(schedulerStatus(stateFile, true).status, 'incompatible')
  assert.throws(() => assertScopedScheduler(stateFile, true), /不支持角色调度/)
  writeFileSync(file, JSON.stringify({ ...valid, accountKey: 'other' }))
  assert.equal(schedulerStatus(stateFile, true, true, 'current').status, 'wrong_account')
  writeFileSync(file, JSON.stringify({ ...valid, state: 'paused', enabled: false }))
  assert.equal(schedulerStatus(stateFile, true).status, 'paused'); assert.doesNotThrow(() => assertScopedScheduler(stateFile, true))
  writeFileSync(file, JSON.stringify({ ...valid, state: 'failed', error: '自醒开关状态损坏' }))
  assert.match(schedulerStatus(stateFile, true).message, /开关状态损坏/)
  assert.throws(() => assertScopedScheduler(stateFile, true), /开关状态损坏/)
})

test('foreign-account scheduling fails before any activation or role declaration is written', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-wake-owner-')), db = new EdenDatabase(':memory:', 'mon')
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  db.connection.prepare("INSERT INTO realm_meta VALUES('account_key',?)").run(JSON.stringify(['http://127.0.0.1/', '2']))
  writeFileSync(path.join(root, 'session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true,
    roleScopes: true, accountKey: 'another-account', expiresAt: Date.now() + 30000 }))
  const awake = new SelfAwakeRepository(db, path.join(root, 'state.json'), true)
  assert.throws(() => awake.timerPublication.publish(), /属于其他账号/)
  assert.equal(existsSync(path.join(root, 'agent_activation.json')), false)
  assert.equal(existsSync(path.join(root, 'role-coordinator.json')), false)
})

test('legacy installation control is imported once and never crosses a non-owner account', t => {
  const db = new EdenDatabase(':memory:', 'mon'); t.after(() => db.close())
  const control = new SelfAwakeRepository(db).control
  control.initialize(false, false); assert.equal(control.read().enabled, true)
  control.initialize(false); const imported = control.read(); assert.equal(imported.enabled, false)
  control.update(true, imported.updatedAt); const saved = control.read()
  control.initialize(false); assert.deepEqual(control.read(), saved)
  assert.throws(() => control.update(false, imported.updatedAt), /已在其他页面修改/)
})
