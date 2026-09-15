import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monServiceConfig } from '../../../src/bootstrap/mon-service-config.ts'

test('Mon paths resolve against an explicit deployment root and failures identify the configured file without secrets', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-mon-paths-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const deployment = path.join(root, 'deployment'); mkdirSync(deployment)
  const config = path.join(root, 'mon-service.json'), auth = path.join(deployment, 'auth.env')
  writeFileSync(config, JSON.stringify({ deploymentRoot: 'deployment', authFile: 'auth.env', coreBaseUrl: 'http://127.0.0.1:40011' }))
  assert.throws(() => monServiceConfig('mon', root, {}), error => {
    assert.match(String(error), /authFile/); assert.ok(String(error).includes(config)); assert.ok(String(error).includes(auth)); return true
  })
  writeFileSync(auth, 'MON_SERVICE_SHARED_SECRET=private-sentinel\n')
  assert.throws(() => monServiceConfig('mon', root, {}), error => {
    assert.match(String(error), /MON_SERVICE_USER_ID/); assert.doesNotMatch(String(error), /private-sentinel/); return true
  })
  writeFileSync(auth, 'MON_SERVICE_SHARED_SECRET=private-sentinel\nMON_SERVICE_USER_ID=2\n')
  assert.equal(monServiceConfig('mon', root, {}).env.MON_SERVICE_USER_ID, '2')
  writeFileSync(config, '{broken')
  const env = { MON_SERVICE_SHARED_SECRET: 'override', MON_SERVICE_USER_ID: '3' }
  assert.deepEqual(monServiceConfig('mon', root, env), { env })
  assert.throws(() => monServiceConfig('mon', root, {}), /格式无效/)
})
