// Real account refresh, tool execution and browser transport in disposable local services.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'
import { browserRpcFixture } from '../../../../frontend/web/tests/helpers/browser-rpc-fixture.mjs'

async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`)
    await delay(10)
  }
}

export async function runToolConnectionScenario() {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-tool-disconnect-'))
  const token = 'fixture-core-token'
  const pendingProfiles = []
  let holdProfiles = false
  let profileRequests = 0
  const core = createServer((request, response) => {
    assert.equal(request.url, '/api/users/me/profile/')
    profileRequests++
    if (holdProfiles) pendingProfiles.push(response)
    else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: '101' }))
  })
  core.listen(0, '127.0.0.1')
  await once(core, 'listening')
  const coreBaseUrl = `http://127.0.0.1:${core.address().port}`
  const model = await recordedModel([
    { tool: 'write_file', input: { path: 'baseline.txt', content: 'baseline', createOnly: true } },
    { text: 'BASELINE_TOOL_COMPLETED' },
    { tool: 'write_file', input: { path: 'during-refresh.txt', content: 'written once', createOnly: true } },
    { text: 'REFRESH_TOOL_COMPLETED' },
  ])
  let releaseFinalReply
  const finalReply = new Promise(resolve => { releaseFinalReply = resolve })
  let modelCalls = 0
  let awaitingFinalReply = false
  const modelProxy = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    if (++modelCalls === 4) {
      awaitingFinalReply = true
      await finalReply
    }
    const upstream = await fetch(`${model.config.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    response.writeHead(upstream.status, { 'content-type': 'text/event-stream' }).end(await upstream.text())
  })
  modelProxy.listen(0, '127.0.0.1')
  await once(modelProxy, 'listening')
  const gatedModel = { ...model.config, baseUrl: `http://127.0.0.1:${modelProxy.address().port}/v1` }
  const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0',
    EDEN_AGENT_DATA_ROOT: path.join(root, 'storage'),
    EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(root, 'terminal-settings.json'),
  }), coreBaseUrl }
  const runtimes = new AccountRuntimes(config)
  const http = createServer((_, response) => response.writeHead(200).end('fixture host alive'))
  const websocket = attachWebsocket(http, config, credential => runtimes.resolve(credential))
  const wire = []
  const closes = []
  websocket.on('connection', socket => {
    const originalSend = socket.send.bind(socket)
    socket.send = function(data, ...args) {
      const value = JSON.parse(String(data))
      if (value.method === 'session.event') wire.push(value.params)
      return originalSend(data, ...args)
    }
    socket.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }))
  })
  let browser
  let result
  try {
    await runtimes.start()
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    browser = await browserRpcFixture({ baseUrl: `http://127.0.0.1:${http.address().port}`,
      capabilityToken: config.token, origin: 'mon', coreToken: token })
    const received = [], statuses = []
    await browser.subscribe(event => received.push(event), (connected, error) => {
      statuses.push({ connected, error: error ?? null, time: Date.now() })
    })
    await until(() => statuses.some(value => value.connected), 'browser connection')
    const connectedAt = Date.now()
    const runtime = await runtimes.resolve(token)
    const session = await browser.transport.rpcRequest('session.create', { title: 'Account refresh tool continuity' })
    runtime.services.models.bind(session.id, { model: gatedModel, entityId: 1, label: 'Local recorded model' })
    const approve = () => {
      const pending = runtime.services.permissions.list(session.id).find(value => value.state === 'pending')
      assert.ok(pending, 'Tool must be waiting for explicit approval')
      runtime.services.permissions.resolve(pending.id, true)
    }
    const hasPending = () => runtime.services.permissions.list(session.id).some(value => value.state === 'pending')
    await browser.transport.rpcRequest('turn.start', { sessionId: session.id, text: 'baseline write', attachments: [] })
    await until(hasPending, 'baseline tool approval')
    approve()
    await runtime.services.sessions.waitForIdle(session.id)
    await browser.transport.rpcRequest('ping', {})
    assert.equal(await readFile(path.join(runtime.services.workspace.root(), 'baseline.txt'), 'utf8'), 'baseline')
    assert.equal(closes.length, 0, 'Ordinary tool call must not disconnect')
    console.log(JSON.stringify({ stage: 'baseline', disconnected: false, modelRequests: model.requests.length }))

    await browser.transport.rpcRequest('turn.start', { sessionId: session.id, text: 'write during refresh', attachments: [] })
    await until(hasPending, 'second tool approval')
    // Keep the real 30-second account refresh behavior; do not patch clocks or authentication.
    holdProfiles = true
    await delay(Math.max(0, 31000 - (Date.now() - connectedAt)))
    const refreshRpc = browser.transport.rpcRequest('ping', {})
    await until(() => pendingProfiles.length > 0, 'in-flight Core account refresh')
    console.log(JSON.stringify({ stage: 'refresh-in-flight', pendingProfiles: pendingProfiles.length }))
    const lastBeforeRefresh = wire.filter(value => value.sessionId === session.id).at(-1)
    const wireBeforeRefresh = wire.length
    const receivedBeforeRefresh = received.length
    approve()
    await until(() => awaitingFinalReply, 'next model request after the tool')
    assert.equal(await readFile(path.join(runtime.services.workspace.root(), 'during-refresh.txt'), 'utf8'), 'written once')
    const durable = runtime.services.repository.events.list(session.id, '0', 1000)
    const deliveredIds = new Set(wire.map(value => value.id))
    const pending = durable.filter(value => !deliveredIds.has(value.id))
    assert.ok(pending.some(value => value.kind === 'operation.completed'), 'Refresh must overlap an actual completed tool event')
    assert.equal(wire.length, wireBeforeRefresh, 'Unverified events must not be sent while Core validation is pending')
    assert.equal(received.length, receivedBeforeRefresh, 'The browser must not receive events before Core validation succeeds')
    holdProfiles = false
    for (const response of pendingProfiles.splice(0))
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: '101' }))
    await refreshRpc
    // The natural reply is still gated, so only refresh completion can release these events.
    await until(() => pending.every(event => received.some(value => value.id === event.id)), 'buffered tool events after successful refresh')
    const pendingIds = new Set(pending.map(value => value.id))
    assert.deepEqual(wire.filter(value => pendingIds.has(value.id)).map(value => value.seq), pending.map(value => value.seq),
      'Buffered events must be sent exactly once in durable sequence order')
    assert.deepEqual(received.filter(value => pendingIds.has(value.id)).map(value => value.seq), pending.map(value => value.seq),
      'The production browser transport must accept the whole buffered sequence')
    assert.equal(closes.length, 0, 'Successful account refresh must not close the WebSocket')
    // The tool's natural model continuation exposes the hole; no injected events or socket close.
    releaseFinalReply()
    await runtime.services.sessions.waitForIdle(session.id)
    await until(() => received.some(value => value.sessionId === session.id && value.eventType === 'turn.completed'
      && BigInt(value.seq) > BigInt(lastBeforeRefresh.seq)), 'natural continuation completion in browser stream')
    const restored = await browser.transport.rpcRequest('event.list', { sessionId: session.id, afterSeq: '0', limit: 1000 })
    const completedSeq = pending.find(item => item.kind === 'operation.completed').seq
    assert.ok(restored.items.some(value => value.eventType === 'operation.completed' && value.seq === completedSeq))
    const messages = await browser.transport.rpcRequest('message.list', { sessionId: session.id, limit: 100 })
    const hasMessage = (events, role, text) => events.some(value => value.eventType === 'agent.message_end'
      && value.payload?.message?.role === role && JSON.stringify(value.payload.message.content).includes(text))
    for (const events of [received, restored.items, messages.items]) {
      assert.ok(hasMessage(events, 'toolResult', 'during-refresh.txt'), 'Completed write result must be available live and in durable history')
      assert.ok(hasMessage(events, 'assistant', 'REFRESH_TOOL_COMPLETED'), 'Natural model reply must be available live and in durable history')
    }
    assert.equal(model.requests.length, 4, 'Account refresh must not rerun the tool/model turn')
    assert.equal(restored.items.filter(value => value.eventType === 'operation.started' && value.payload.name === 'write_file').length, 2,
      'Each requested file write must execute only once')
    const sequences = received.filter(value => value.sessionId === session.id).map(value => BigInt(value.seq))
    for (let index = 1; index < sequences.length; index++) assert.equal(sequences[index], sequences[index - 1] + 1n)
    assert.equal(closes.length, 0, 'Tool execution and its natural continuation must keep the WebSocket open')
    assert.deepEqual(statuses.map(value => value.connected), [true], 'The frontend must stay connected throughout successful refresh')
    result = { node: process.version, stage: 'regression-passed', profileRequests,
      lastBeforeRefresh: { seq: lastBeforeRefresh.seq, type: lastBeforeRefresh.eventType },
      bufferedAndDelivered: pending.map(value => ({ seq: value.seq, type: value.kind })), closes,
      connectionStates: statuses.map(value => value.connected ? 'connected' : 'disconnected'),
      toolCompleted: true, historyRecovered: true, modelRequests: model.requests.length }
    console.log(JSON.stringify(result, null, 2))
  } finally {
    releaseFinalReply()
    holdProfiles = false
    for (const response of pendingProfiles.splice(0)) response.destroy()
    await browser?.close()
    for (const socket of websocket.clients) socket.terminate()
    websocket.close()
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    await runtimes.close()
    modelProxy.closeAllConnections()
    await new Promise(resolve => modelProxy.close(resolve))
    await model.close()
    core.closeAllConnections()
    await new Promise(resolve => core.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
  return result
}
