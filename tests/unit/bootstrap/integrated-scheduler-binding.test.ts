import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { monServiceConfig } from '../../../src/bootstrap/mon-service-config.ts'
import { workspaceSchedulerStateFile } from '../../../src/bootstrap/mon-scheduler-path.ts'
import { osWakeTarget } from '../../../src/bootstrap/os-wake-target.ts'
import type { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'

test('current server+agent manifests resolve the exact account path used by the integrated writer', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-integrated-scheduler-')), agent = path.join(root, 'runtime/agent')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(agent, { recursive: true }); mkdirSync(path.join(root, 'Config/Os'), { recursive: true })
  mkdirSync(path.join(root, 'Config/ENV'), { recursive: true }); mkdirSync(path.join(root, 'Data/Os/SelfAwake'), { recursive: true })
  writeFileSync(path.join(root, '.monconfig'), '')
  writeFileSync(path.join(root, '.monworkspace'), JSON.stringify({ modules: [{ id: 'server', root: 'runtime/core' }, { id: 'agent', root: 'runtime/agent' }] }))
  writeFileSync(path.join(root, 'Config/Os/.monconfig'), '[self_awake]\nENABLED=false\nDATA_DIR=../../Data/Os/SelfAwake\n')
  writeFileSync(path.join(root, 'Config/ENV/service-auth.env'), 'MON_SERVICE_SHARED_SECRET=fixture-secret\nMON_SERVICE_USER_ID=2\n')
  writeFileSync(path.join(root, 'Data/Os/SelfAwake/session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true, expiresAt: 1 }))
  const env = { EDEN_AGENT_RUNTIME_ORIGIN: 'mon' }, config = loadConfig(env, agent)
  const binding = monServiceConfig('mon', config.dataRoot, env, root)
  assert.equal(binding.scheduleStateFile, config.selfAwakeScheduleFile)
  assert.equal(workspaceSchedulerStateFile(root, binding.env), config.selfAwakeScheduleFile)
  assert.equal(config.selfAwakeScheduleFile, path.join(config.os!.wakeDir, 'state.json'))
  assert.equal(path.basename(config.selfAwakeScheduleFile!), 'state.json')
  assert.match(path.basename(path.dirname(config.selfAwakeScheduleFile!)), /^[a-f0-9]{64}$/)
  assert.equal(path.basename(path.dirname(path.dirname(config.selfAwakeScheduleFile!))), 'accounts')
  assert.equal(config.os!.selfAwakeEnabled, false)
  assert.equal(existsSync(path.join(root, 'BaseOs')), false)
  assert.equal(existsSync(path.dirname(config.selfAwakeScheduleFile!)), false, 'path discovery never manufactures a live lease')
  const other = loadConfig({ ...env, MON_SERVICE_SHARED_SECRET: 'fixture-secret', MON_SERVICE_USER_ID: '3' }, agent)
  assert.notEqual(other.selfAwakeScheduleFile, config.selfAwakeScheduleFile)
})

test('the OS coordinator waits only for its owner account, independently of unrelated account failures', () => {
  const owner = { key: 'owner', userId: '2', coreBaseUrl: 'http://127.0.0.1/' }
  const seen: unknown[] = []
  const runtimes = { serviceAccount: () => owner, ready: (account?: unknown) => { seen.push(account); return account === owner } } as unknown as AccountRuntimes
  assert.equal(osWakeTarget(runtimes).ready(), true)
  assert.deepEqual(seen, [owner])
})
