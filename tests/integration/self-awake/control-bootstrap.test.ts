import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { accountKey } from '../../../src/modules/accounts/index.ts'

test('production service bootstrap imports legacy disable once and preserves a later account enable on reopen', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-control-bootstrap-')), osRoot = path.join(root, 'os-config')
  mkdirSync(osRoot)
  const legacy = path.join(osRoot, '.monconfig')
  writeFileSync(legacy, '[self_awake]\nENABLED=false\n')
  const account = { coreBaseUrl: 'http://127.0.0.1:1', userId: '2', key: accountKey('http://127.0.0.1:1', '2') }
  const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_DATA_ROOT: path.join(root, 'realm'),
    EDEN_AGENT_OS_ROOT: osRoot, MON_CORE_BASE_URL: account.coreBaseUrl, MON_SERVICE_SHARED_SECRET: 'fixture-secret',
    MON_SERVICE_USER_ID: account.userId }, root), account }
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
  t.after(async () => { await runtime?.close(); rmSync(root, { recursive: true, force: true }) })
  runtime = await openRuntime(config)
  const control = runtime.services.selfAwake.repository.control
  assert.equal(control.read().enabled, false)
  control.update(true, control.read().updatedAt)
  const saved = control.read()
  await runtime.close()
  runtime = await openRuntime(config)
  assert.deepEqual(runtime.services.selfAwake.repository.control.read(), saved)
  assert.equal(config.os!.selfAwakeEnabled, false)
  assert.equal(readFileSync(legacy, 'utf8'), '[self_awake]\nENABLED=false\n')
})
