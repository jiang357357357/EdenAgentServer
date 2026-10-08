import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'
import { initializeSchema, rpcNotifications } from '@eden/api'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import type { RuntimeScope } from '../../../src/bootstrap/runtime-scope.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'

const require = createRequire(import.meta.url)
const { createRealmRpc } = require('../../../../frontend/desktop/src/processes/realm-rpc.cjs')
const { createDesktopReminderService } = require('../../../../frontend/desktop/src/reminders/reminder-service.cjs')
type World = 'mon' | 'local'
async function until(condition: () => boolean) {
  for (let i = 0; i < 400; i++) { if (condition()) return; await pause(5) }
  assert.fail('Reminder integration did not reach the expected state')
}
function createReminder(runtime: RuntimeScope, label: string) {
  return withAccount(runtime.config.account, () => {
    const session = runtime.services.repository.create(label)
    const inputs = new InputRepository(runtime.database, runtime.services.repository.events)
    inputs.enqueue(session.id, label, label)
    const input = inputs.claim(session.id)!
    return runtime.services.desktopReminders.create(session.id, input.turnId, { title: label, message: 'Fixture content only' }, label)
  })
}

test('real reminder connections push changes, catch up after reconnect and isolate accounts/worlds', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eden-reminder-push-'))
  const priorRoot = process.env.MON_WORKSPACE_ROOT, priorDlc = process.env.MON_SHARED_WORKSPACE_DLC_ROOT
  await writeFile(path.join(directory, '.monworkspace'), '{}'); await writeFile(path.join(directory, '.monconfig'), '{}')
  process.env.MON_WORKSPACE_ROOT = directory; process.env.MON_SHARED_WORKSPACE_DLC_ROOT = path.join(directory, 'missing-dlc')
  let token: string | null = 'fixture-a'
  const core = createServer((request, response) => {
    if (request.url === '/api/users/me/profile/') {
      const value = request.headers.authorization
      if (value !== 'Token fixture-a' && value !== 'Token fixture-b') { response.writeHead(401).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: value.endsWith('-a') ? 71 : 72 }))
    } else response.writeHead(404).end()
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const worlds = (['mon', 'local'] as const).map(origin => {
    const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: origin, EDEN_AGENT_PORT: '0',
      MON_WORKSPACE_ROOT: directory,
      EDEN_AGENT_DATA_ROOT: path.join(directory, origin), EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(directory, 'terminal.json') }),
      coreBaseUrl: `http://127.0.0.1:${(core.address() as AddressInfo).port}` }
    const runtimes = new AccountRuntimes(config), host = createServer()
    const server = attachWebsocket(host, config, value => runtimes.resolve(value))
    return { origin, config, runtimes, host, server }
  })
  const messages: { origin: World; value: any }[] = [], created: any[] = [], warnings: string[] = []
  const connections = { mon: 0, local: 0 }, reads = { mon: 0, local: 0 }
  let service: { start(): void; close(): void; authenticationChanged(): void } | undefined
  let rpc: ReturnType<typeof createRealmRpc> | undefined
  try {
    for (const world of worlds) {
      await world.runtimes.start(); world.host.listen(0, '127.0.0.1'); await once(world.host, 'listening')
      world.server.on('connection', socket => {
        connections[world.origin]++
        socket.on('message', data => { if (JSON.parse(data.toString()).method === 'desktop.reminder.list') reads[world.origin]++ })
      })
    }
    const capability = (origin: World) => {
      const world = worlds.find(value => value.origin === origin)!
      return { token: world.config.token, baseUrl: `http://127.0.0.1:${(world.host.address() as AddressInfo).port}` }
    }
    class ObservedWebSocket extends WebSocket {
      constructor(url: URL, protocols: string[]) {
        super(url, protocols)
        const origin = worlds.find(world => String((world.host.address() as AddressInfo).port) === url.port)!.origin
        this.on('message', data => messages.push({ origin, value: JSON.parse(data.toString()) }))
      }
    }
    rpc = createRealmRpc({ capability, coreToken: () => token, WebSocketClass: ObservedWebSocket })
    service = createDesktopReminderService({ rpcRequest: rpc, coreToken: () => token, retryIntervalMs: 30,
      logger: { warn: (message: string) => warnings.push(message) },
      createWindow: (options: any) => {
        let destroyed = false
        const window = { isDestroyed: () => destroyed, destroy() { destroyed = true; options.onClosed() } }
        created.push({ options, window }); return window
      },
    })
    service!.start(); await until(() => reads.mon === 1 && reads.local === 1)
    // Wait longer than the failure retry interval; healthy empty queues must remain idle.
    await pause(150); assert.deepEqual(reads, { mon: 1, local: 1 }); assert.deepEqual(connections, { mon: 1, local: 1 })
    const mon = worlds[0], local = worlds[1]
    assert.ok(mon); assert.ok(local)
    const runtimeA = await mon.runtimes.resolve('fixture-a'), runtimeB = await mon.runtimes.resolve('fixture-b')
    const localRuntime = local.runtimes.defaultRuntime()
    const reminderA = createReminder(runtimeA, 'account-a-reminder'), localReminder = createReminder(localRuntime, 'local-reminder')
    await until(() => created.length === 2)
    const windowA = created.find(value => value.options.reminder.id === reminderA.id)
    const localWindow = created.find(value => value.options.reminder.id === localReminder.id)
    assert.ok(windowA); assert.ok(localWindow); assert.deepEqual(connections, { mon: 1, local: 1 })
    await windowA.options.displayed(); await localWindow.options.displayed()
    await pause(40); assert.equal(created.length, 2); assert.equal(windowA.window.isDestroyed(), false)
    // Interleaved unrelated durable events must never be replayed by the reminder channel.
    withAccount(runtimeA.config.account, () => runtimeA.services.repository.events.append(reminderA.sessionId, reminderA.turnId,
      'fixture.private-stream', { text: 'fixture-private-stream-must-not-enter-reminders' }))
    withAccount(runtimeA.config.account, () => runtimeA.services.desktopReminders.transition(reminderA.id, 'closed'))
    await until(() => windowA.window.isDestroyed())
    const reminderB = createReminder(runtimeB, 'account-b-reminder')
    await pause(40); assert.equal(created.length, 2, 'Account B events must not reach account A')
    token = 'fixture-b'; service!.authenticationChanged()
    await until(() => created.some(value => value.options.reminder.id === reminderB.id))
    assert.equal(localWindow.window.isDestroyed(), false); assert.equal(connections.local, 1)
    await assert.rejects(windowA.options.acknowledge(), /account changed/)
    const windowB = created.find(value => value.options.reminder.id === reminderB.id)
    await windowB.options.acknowledge(); await until(() => windowB.window.isDestroyed())
    const monReads = reads.mon
    // Simulate loss of the local socket, and persist a reminder while disconnected.
    for (const socket of local.server.clients) socket.terminate()
    await until(() => local.server.clients.size === 0)
    withAccount(undefined, () => localRuntime.services.desktopReminders.transition(localReminder.id, 'closed'))
    const offline = createReminder(localRuntime, 'offline-local-reminder')
    await until(() => created.some(value => value.options.reminder.id === offline.id))
    assert.equal(localWindow.window.isDestroyed(), true); assert.equal(connections.local, 2)
    assert.equal(reads.mon, monReads)
    token = null; service!.authenticationChanged()
    await until(() => mon.server.clients.size === 0)
    assert.equal(local.server.clients.size, 1)
    const notifications = messages.filter(value => value.value.method)
    assert.ok(notifications.length >= 4)
    for (const { origin, value } of notifications) {
      assert.equal(value.method, 'desktop.reminder.changed')
      assert.deepEqual(rpcNotifications['desktop.reminder.changed'].parse(value.params), { runtimeOrigin: origin })
      assert.deepEqual(Object.keys(value.params), ['runtimeOrigin'])
    }
    assert.equal(JSON.stringify(messages).includes('fixture-private-stream-must-not-enter-reminders'), false)
    assert.deepEqual(warnings, [])
    service!.close(); await until(() => worlds.every(world => world.server.clients.size === 0))
  } finally {
    service?.close(); rpc?.close()
    for (const world of worlds) {
      for (const socket of world.server.clients) socket.terminate()
      world.server.close(); world.host.closeAllConnections()
      await new Promise<void>(resolve => world.host.close(() => resolve()))
      await world.runtimes.close()
    }
    core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve()))
    if (priorRoot === undefined) delete process.env.MON_WORKSPACE_ROOT; else process.env.MON_WORKSPACE_ROOT = priorRoot
    if (priorDlc === undefined) delete process.env.MON_SHARED_WORKSPACE_DLC_ROOT; else process.env.MON_SHARED_WORKSPACE_DLC_ROOT = priorDlc
    await rm(directory, { recursive: true, force: true })
  }
})

test('reminder event mode is control-only and cannot request session replay', () => {
  const base = { protocolVersion: 2, runtimeOrigin: 'local', clientName: 'fixture', clientVersion: 'fixture', capabilities: [], eventMode: 'reminders' }
  assert.equal(initializeSchema.safeParse(base).success, true)
  assert.equal(initializeSchema.safeParse({ ...base, sessionId: 'ba7403f3-b9d8-42af-8e73-17f38ae52c1c' }).success, false)
  assert.equal(initializeSchema.safeParse({ ...base, afterSeq: '0' }).success, false)
})
