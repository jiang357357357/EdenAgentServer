import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

test('fresh unbound installation opens both listeners before Core; recovery starts when Core becomes ready', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-os-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'Config/ENV'), { recursive: true })
  writeFileSync(path.join(root, '.monconfig'), '[workspace]\nNAME=test\n')
  writeFileSync(path.join(root, '.monworkspace'), '{"modules":[]}')
  writeFileSync(path.join(root, 'Config/ENV/service-auth.env'), 'MON_SERVICE_SHARED_SECRET=unbound-fixture-secret\n')
  const core = createServer((request, response) => response.end('pong'))
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const corePort = (core.address() as AddressInfo).port
  await new Promise<void>(resolve => core.close(() => resolve()))
  const config = loadConfig({ MON_WORKSPACE_ROOT: root, EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0', EDEN_AGENT_OS_PORT: '0',
    EDEN_AGENT_OS_ROOT: path.join(root, 'os'), EDEN_AGENT_DATA_ROOT: path.join(root, 'agent'), MON_CORE_BASE_URL: `http://127.0.0.1:${corePort}` }, root)
  assert.equal(config.monIdentity, undefined)
  const host = await startServer(config)
  try {
    const health = await (await fetch(`http://127.0.0.1:${host.osPort}/health`)).json() as { pid: number }
    assert.equal(health.pid, process.pid)
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/readyz`)).status, 503)
    core.listen(corePort, '127.0.0.1'); await once(core, 'listening')
    const deadline = Date.now() + 10000
    while ((await fetch(`http://127.0.0.1:${host.port}/readyz`)).status !== 200) {
      assert.ok(Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally { await host.close(); await new Promise<void>(resolve => core.close(() => resolve())) }
  await assert.rejects(fetch(`http://127.0.0.1:${host.osPort}/health`))
  await assert.rejects(fetch(`http://127.0.0.1:${host.port}/healthz`))
})
