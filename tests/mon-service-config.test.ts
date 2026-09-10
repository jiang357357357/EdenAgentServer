import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monServiceConfig } from '../src/bootstrap/mon-service-config.ts'
import { monServiceIdentity } from '../src/bootstrap/mon-identity.ts'
import { readExternalSchedule } from '../src/modules/self-awake/external-schedule.ts'

test('explicit Mon installation identity stays isolated and environment overrides stay atomic', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-mon-identity-'))
  try {
    assert.equal(monServiceIdentity('mon', monServiceConfig('mon', root, {}).env), undefined)
    const authFile = path.join(root, 'service-auth.env'), scheduleStateFile = path.join(root, 'state.json')
    writeFileSync(authFile, 'MON_SERVICE_SHARED_SECRET="test-secret"\nMON_SERVICE_USER_ID=2\nUNRELATED_TOKEN=hidden\n')
    writeFileSync(path.join(root, 'mon-service.json'), JSON.stringify({ authFile, scheduleStateFile, coreBaseUrl: 'http://127.0.0.1:40011' }))
    const loaded = monServiceConfig('mon', root, {})
    assert.equal(monServiceIdentity('mon', loaded.env)?.userId, '2')
    assert.equal(monServiceIdentity('mon', loaded.env)?.secret, 'test-secret')
    assert.equal(loaded.env.UNRELATED_TOKEN, undefined)
    assert.equal(loaded.scheduleStateFile, scheduleStateFile)
    assert.deepEqual(monServiceConfig('local', root, {}), { env: {} })
    const override = monServiceConfig('mon', root, { MON_SERVICE_USER_ID: '3' })
    assert.equal(override.scheduleStateFile, undefined)
    assert.throws(() => monServiceIdentity('mon', override.env))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('external schedule preserves time zone and rejects malformed state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-mon-schedule-'))
  const file = path.join(root, 'state.json')
  try {
    assert.equal(readExternalSchedule(), null)
    writeFileSync(file, JSON.stringify({ enabled: true, next_wake_at: '2026-09-10T19:41:53+08:00', next_wake_reason: 'timer' }))
    assert.deepEqual(readExternalSchedule(file), { status: 'scheduled', nextWakeAt: '2026-09-10T11:41:53.000Z', reason: 'timer' })
    writeFileSync(file, JSON.stringify({ enabled: false, next_wake_at: null }))
    assert.equal(readExternalSchedule(file), null)
    writeFileSync(file, '{')
    assert.throws(() => readExternalSchedule(file), /无法读取 MonOs/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
