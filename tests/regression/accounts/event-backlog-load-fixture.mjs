// Synthetic persisted-event load: real Core HTTP, account runtimes, sockets and browser transport; no model call.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as yieldIo, setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'
import { wireEvent } from '../../../src/transport/rpc/session.routes.ts'
import { browserRpcFixture } from '../../../../frontend/web/tests/helpers/browser-rpc-fixture.mjs'

const scenarios = {
  count: { events: 1200, textBytes: 32, pageSize: 64 },
  bytes: { events: 12, textBytes: 384 * 1024, pageSize: 2 },
}
const eventType = 'fixture.synthetic_backlog'

async function until(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timeout waiting for ${label}`)
    await delay(10)
  }
}

async function observerConnection(baseUrl, capability, token) {
  const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/rpc', ['eden-agent-rpc-v2', `eden-agent-token.${capability}`])
  const received = [], closes = [], pending = new Map()
  let nextId = 0
  socket.on('message', data => {
    const message = JSON.parse(String(data))
    if (message.method === 'session.event') received.push(message.params)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.on('close', (code, reason) => {
    closes.push({ code, reason: String(reason) })
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Observer connection closed')) }
    pending.clear()
  })
  await once(socket, 'open')
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Observer RPC timeout: ${method}`)) }, 10_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  await request('initialize', { protocolVersion: 2, runtimeOrigin: 'mon', clientName: 'healthy-load-observer',
    clientVersion: 'test', capabilities: ['session-events'], coreToken: token })
  return { socket, received, closes, request }
}

export async function runEventBacklogScenario(name) {
  const scenario = scenarios[name]
  if (!scenario) throw new Error(`Unknown backlog scenario: ${name}`)
  const directory = await mkdtemp(path.join(tmpdir(), `eden-event-backlog-${name}-`))
  const slowToken = 'fixture-slow-core-token', fastToken = 'fixture-fast-core-token'
  const pendingProfiles = []
  let holdProfiles = false, profileRequests = 0
  const replyProfile = response => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: '501' }))
  const core = createServer((request, response) => {
    if (request.url !== '/api/users/me/profile/') { response.writeHead(404).end(); return }
    profileRequests++
    if (holdProfiles && request.headers.authorization === `Token ${slowToken}`) pendingProfiles.push(response)
    else replyProfile(response)
  })
  let host, websocket, runtimes, browser, observer
  const connections = []
  let generatedCount = 0, generatedBytes = 0, appendInProgress = null
  try {
    core.listen(0, '127.0.0.1'); await once(core, 'listening')
    const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0',
      EDEN_AGENT_DATA_ROOT: path.join(directory, 'storage'),
      EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(directory, 'terminal-settings.json'),
    }), coreBaseUrl: `http://127.0.0.1:${core.address().port}` }
    runtimes = new AccountRuntimes(config)
    await runtimes.start()
    host = createServer((_, response) => response.writeHead(200).end('fixture host alive'))
    websocket = attachWebsocket(host, config, credential => runtimes.resolve(credential))
    websocket.on('connection', socket => {
      const record = { id: connections.length + 1, closeRequests: [], closes: [], maxBufferedAmount: 0 }
      connections.push(record)
      const originalClose = socket.close.bind(socket)
      socket.close = function(code, reason) {
        record.closeRequests.push({ code, reason: String(reason ?? ''), appendInProgress,
          completedAppendCount: generatedCount, completedFrameBytes: generatedBytes, coreProfileHeld: holdProfiles })
        return originalClose(code, reason)
      }
      const originalSend = socket.send.bind(socket)
      socket.send = function(data, ...args) {
        const result = originalSend(data, ...args)
        record.maxBufferedAmount = Math.max(record.maxBufferedAmount, socket.bufferedAmount)
        return result
      }
      socket.on('close', (code, reason) => record.closes.push({ code, reason: String(reason) }))
    })
    host.listen(0, '127.0.0.1'); await once(host, 'listening')
    const baseUrl = `http://127.0.0.1:${host.address().port}`
    browser = await browserRpcFixture({ baseUrl, capabilityToken: config.token, origin: 'mon', coreToken: slowToken })
    const received = [], statuses = []
    await browser.subscribe(value => received.push(value), (connected, error) => statuses.push({ connected, error }))
    await until(() => statuses.some(value => value.connected), 'browser initialization')
    const connectedAt = Date.now()
    const runtime = await runtimes.resolve(slowToken)
    observer = await observerConnection(baseUrl, config.token, fastToken)
    const sessions = []
    for (let index = 0; index < 4; index++) sessions.push(await browser.transport.rpcRequest('session.create', { title: `Synthetic ${name} load ${index}` }))
    await observer.request('ping', {})
    console.log(`BACKLOG_READY ${name} pid=${process.pid}`)
    holdProfiles = true
    // Preserve the production refresh interval; hold the HTTP response only during load generation (below its 10s timeout).
    await delay(Math.max(0, 31000 - (Date.now() - connectedAt)))
    const refreshRpc = browser.transport.rpcRequest('ping', {}).then(() => ({ ok: true }), error => ({ error: error.message }))
    await until(() => pendingProfiles.length > 0, 'real account refresh HTTP request')
    const generated = [], startedAt = Date.now()
    let totalBytes = 0, maximumFrameBytes = 0
    const text = 'x'.repeat(scenario.textBytes)
    for (let index = 0; index < scenario.events; index++) {
      const session = sessions[index % sessions.length]
      appendInProgress = index + 1
      const durable = runtime.services.repository.events.append(session.id, null, eventType, { scenario: name, index, text })
      generated.push(durable)
      const frameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: wireEvent(durable) }))
      totalBytes += frameBytes; maximumFrameBytes = Math.max(maximumFrameBytes, frameBytes)
      generatedCount = generated.length; generatedBytes = totalBytes
      appendInProgress = null
      // Keep the healthy connection draining; this test targets auth backlog, not an artificial blocked network receiver.
      await yieldIo()
    }
    const loadDurationMs = Date.now() - startedAt
    await until(() => observer.received.filter(value => value.eventType === eventType).length === scenario.events, 'healthy peer event delivery')
    const receivedWhileUnverified = received.filter(value => value.eventType === eventType).length
    const closedBeforeCoreSuccess = connections[0].closes.map(value => ({ ...value }))
    holdProfiles = false
    for (const response of pendingProfiles.splice(0)) replyProfile(response)
    const refreshOutcome = await refreshRpc
    await until(() => statuses.at(-1)?.connected === true, 'browser connection after Core success')
    const recovered = [], pagesPerSession = []
    for (const session of sessions) {
      let afterSeq = '0', pages = 0
      while (true) {
        const page = await browser.transport.rpcRequest('event.list', { sessionId: session.id, afterSeq, limit: scenario.pageSize })
        pages++
        recovered.push(...page.items.filter(value => value.eventType === eventType))
        if (!page.hasMore) break
        assert.ok(page.nextCursor && page.nextCursor !== afterSeq, 'Event history pagination must advance')
        afterSeq = page.nextCursor
      }
      pagesPerSession.push({ sessionId: session.id, pages })
    }
    const pressureIds = new Set(generated.map(value => value.id))
    const recoverIds = recovered.map(value => value.id)
    assert.equal(new Set(recoverIds).size, scenario.events, 'Per-session history must recover every persisted pressure event')
    assert.equal(recoverIds.length, scenario.events, 'History pages must not duplicate pressure events')
    assert.ok(recoverIds.every(id => pressureIds.has(id)))
    for (const session of sessions) {
      const expected = generated.filter(value => value.sessionId === session.id).map(value => value.seq)
      assert.deepEqual(recovered.filter(value => value.sessionId === session.id).map(value => value.seq), expected)
      assert.deepEqual(observer.received.filter(value => value.sessionId === session.id && value.eventType === eventType).map(value => value.seq), expected)
    }
    assert.equal(receivedWhileUnverified, 0, 'Unverified browser must receive no pressure events')
    assert.deepEqual(observer.closes, [], 'An independently verified connection must remain usable')
    assert.ok(maximumFrameBytes < 2 * 1024 * 1024, 'Each pressure frame must remain below 2 MiB')
    assert.ok(name === 'count' ? scenario.events > 1024 && totalBytes < 4 * 1024 * 1024 : totalBytes > 4 * 1024 * 1024 && scenario.events < 1024)
    // Wait for healthy delivery on the fixed implementation; old implementations close before this point.
    if (!statuses.some(value => !value.connected)) await until(() => received.filter(value => value.eventType === eventType).length === scenario.events, 'browser backlog delivery')
    const result = { scenario: name, node: process.version, syntheticEvents: scenario.events, sessions: sessions.length,
      totalBytes, maximumFrameBytes, loadDurationMs, profileRequests, receivedWhileUnverified,
      liveDelivered: received.filter(value => value.eventType === eventType).length, recovered: recovered.length,
      healthyPeerReceived: observer.received.filter(value => value.eventType === eventType).length,
      healthyPeerCloses: observer.closes, closedBeforeCoreSuccess, connections,
      connectionStates: statuses.map(value => value.connected ? 'connected' : 'disconnected'), pagesPerSession, refreshOutcome }
    console.log(`BACKLOG_RESULT ${JSON.stringify(result)}`)
    assert.deepEqual(statuses.map(value => value.connected), [true], 'Successful account refresh must not disconnect for a durable event backlog')
    assert.deepEqual(connections[0].closes, [], 'A persisted auth backlog must not trigger 1013')
    const live = received.filter(value => value.eventType === eventType)
    assert.equal(live.length, generated.length, 'The original browser connection must receive every persisted backlog event exactly once')
    assert.deepEqual(live.map(value => value.id), generated.map(value => value.id),
      'Merged sessions must retain their global durable append order')
    assert.deepEqual(live.map(value => value.id).sort(), generated.map(value => value.id).sort())
    for (const session of sessions) {
      assert.deepEqual(live.filter(value => value.sessionId === session.id).map(value => value.seq),
        generated.filter(value => value.sessionId === session.id).map(value => value.seq), 'Each session must retain its own durable order')
    }
    return result
  } finally {
    holdProfiles = false
    for (const response of pendingProfiles.splice(0)) response.destroy()
    await browser?.close()
    observer?.socket.terminate()
    if (websocket) { for (const socket of websocket.clients) socket.terminate(); websocket.close() }
    if (host) { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)) }
    await runtimes?.close()
    core.closeAllConnections(); await new Promise(resolve => core.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runEventBacklogScenario(process.argv[2])
}
