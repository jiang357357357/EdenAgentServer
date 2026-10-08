import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { monServiceConfig } from '../../../src/bootstrap/mon-service-config.ts'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-workspace-auth-'))
  const agent = path.join(root, 'Agent'), realm = path.join(agent, 'Data', 'realms', 'mon')
  mkdirSync(realm, { recursive: true })
  mkdirSync(path.join(root, 'Config', 'ENV'), { recursive: true })
  writeFileSync(path.join(root, '.monconfig'), '')
  writeFileSync(path.join(root, '.monworkspace'), '{}')
  const authFile = path.join(root, 'Config', 'ENV', 'service-auth.env')
  writeFileSync(authFile, 'MON_SERVICE_SHARED_SECRET=fixture-secret\nMON_SERVICE_USER_ID=2\nUNRELATED_TOKEN=private\n')
  return { root, agent, realm, authFile, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('source server loads the configured service account from its own anchored workspace', () => {
  const f = fixture()
  try {
    const config = loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon' }, f.agent)
    assert.equal(config.monWorkspaceRoot, f.root)
    assert.equal(config.monIdentity?.userId, '2')
    assert.equal(config.monIdentity?.secret, 'fixture-secret')
    assert.equal(config.monIdentity?.coreBaseUrl, 'http://127.0.0.1:40011')
    assert.equal(monServiceConfig('mon', f.realm, {}, f.root).env.UNRELATED_TOKEN, undefined)
    assert.equal(loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'local' }, f.agent).monIdentity, undefined)
  } finally { f.close() }
})

test('explicit realm deployment and complete environment identity take priority over workspace auth', () => {
  const f = fixture()
  try {
    const otherAuth = path.join(f.realm, 'explicit.env')
    writeFileSync(otherAuth, 'MON_SERVICE_SHARED_SECRET=explicit-secret\nMON_SERVICE_USER_ID=3\n')
    writeFileSync(path.join(f.realm, 'mon-service.json'), JSON.stringify({ authFile: otherAuth, coreBaseUrl: 'http://127.0.0.1:40111' }))
    const loaded = monServiceConfig('mon', f.realm, {}, f.root)
    assert.equal(loaded.env.MON_SERVICE_USER_ID, '3')
    assert.equal(loaded.env.MON_SERVICE_SHARED_SECRET, 'explicit-secret')
    assert.equal(loaded.env.MON_CORE_BASE_URL, 'http://127.0.0.1:40111')
    const env = { MON_SERVICE_SHARED_SECRET: 'override', MON_SERVICE_USER_ID: '4' }
    assert.deepEqual(monServiceConfig('mon', f.realm, env, f.root), { env })
    assert.throws(() => monServiceConfig('mon', f.realm, { MON_SERVICE_USER_ID: '4' }, f.root), /缺少 MON_SERVICE_SHARED_SECRET/)
  } finally { f.close() }
})

test('absent binding stays unavailable and an incomplete binding cannot borrow other credentials', () => {
  const f = fixture()
  try {
    rmSync(f.authFile)
    assert.equal(loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon' }, f.agent).monIdentity, undefined)
    writeFileSync(f.authFile, 'MON_SERVICE_USER_ID=2\n')
    assert.throws(() => loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon' }, f.agent), /缺少 MON_SERVICE_SHARED_SECRET/)
    assert.throws(() => monServiceConfig('mon', f.realm, {}, f.agent), /已锚定的当前工作区/)
  } finally { f.close() }
})
