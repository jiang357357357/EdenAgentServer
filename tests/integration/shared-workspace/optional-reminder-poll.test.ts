import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { configureLogging, loggingFile } from '../../../src/modules/logging/index.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'

const require = createRequire(import.meta.url)
const { createRealmRpc } = require('../../../../frontend/desktop/src/processes/realm-rpc.cjs')

test('repeated desktop reminder requests reuse authentication with built-in reception and no publisher DLC', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eden-optional-reminder-'))
  const priorRoot = process.env.MON_WORKSPACE_ROOT, priorDlc = process.env.MON_SHARED_WORKSPACE_DLC_ROOT
  await writeFile(path.join(directory, '.monworkspace'), '{}')
  await writeFile(path.join(directory, '.monconfig'), '{}')
  await mkdir(path.join(directory, '.run', 'dlc'), { recursive: true })
  process.env.MON_WORKSPACE_ROOT = directory
  process.env.MON_SHARED_WORKSPACE_DLC_ROOT = path.join(directory, 'missing-dlc')
  const logOptions = { origin: 'mon' as const, dataRoot: directory,
    env: { EDEN_AGENT_LOG_DIR: path.join(directory, 'logs'), EDEN_AGENT_LOG_FORMAT: 'json' } }
  const logging = configureLogging(logOptions)
  let profiles = 0, sharedRequests = 0
  const core = createServer((request, response) => {
    if (request.url === '/api/users/me/profile/') {
      assert.equal(request.headers.authorization, 'Token reminder-fixture-only')
      profiles++; response.writeHead(200, { 'content-type': 'application/json' }).end('{"id":31}')
    } else {
      if (request.url?.includes('shared-workspace')) sharedRequests++
      response.writeHead(404).end()
    }
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0',
    MON_WORKSPACE_ROOT: directory,
    EDEN_AGENT_DATA_ROOT: path.join(directory, 'data'), EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(directory, 'terminal.json') }),
    coreBaseUrl: `http://127.0.0.1:${(core.address() as AddressInfo).port}` }
  const runtimes = new AccountRuntimes(config), host = createServer()
  const server = attachWebsocket(host, config, token => runtimes.resolve(token))
  let rpc: ReturnType<typeof createRealmRpc> | undefined
  try {
    await runtimes.start(); host.listen(0, '127.0.0.1'); await once(host, 'listening')
    const capability = () => ({ origin: 'mon', token: config.token, baseUrl: `http://127.0.0.1:${(host.address() as AddressInfo).port}` })
    const coreToken = () => 'reminder-fixture-only'
    rpc = createRealmRpc({ capability, coreToken, WebSocketClass: WebSocket })
    assert.deepEqual(await rpc('mon', 'desktop.reminder.list', {}), [])
    const firstProfiles = profiles
    for (let i = 0; i < 5; i++) assert.deepEqual(await rpc('mon', 'desktop.reminder.list', {}), [])
    assert.equal(profiles, firstProfiles, 'Repeated reads must not repeat account initialization')
    assert.equal(server.clients.size, 1)
    const runtime = await runtimes.resolve('reminder-fixture-only')
    await runtime.services.sharedWorkspace.backgroundReady()
    const status = await runtime.services.sharedWorkspace.status()
    assert.equal(status.available, true)
    assert.equal(status.canPublish, false)
    assert.equal(status.bound, false)
    assert.ok(firstProfiles >= 2, 'The real connection and runtime authenticated the fixture account')
    assert.equal(sharedRequests, 0)
    const events = existsSync(loggingFile(logOptions)) ? (await readFile(loggingFile(logOptions), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { event: string }) : []
    assert.equal(events.filter(record => record.event === 'shared_workspace.registry_restore_failed').length, 0)
  } finally {
    rpc?.close()
    for (const socket of server.clients) socket.terminate()
    server.close(); host.closeAllConnections(); core.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => host.close(() => resolve())), new Promise<void>(resolve => core.close(() => resolve()))])
    await runtimes.close(); logging.close()
    if (priorRoot === undefined) delete process.env.MON_WORKSPACE_ROOT; else process.env.MON_WORKSPACE_ROOT = priorRoot
    if (priorDlc === undefined) delete process.env.MON_SHARED_WORKSPACE_DLC_ROOT; else process.env.MON_SHARED_WORKSPACE_DLC_ROOT = priorDlc
    await rm(directory, { recursive: true, force: true })
  }
})
