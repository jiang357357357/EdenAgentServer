import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { tokenProtocolPrefix, websocketProtocol } from '@eden/api'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'
import { browserRpcFixture } from '../../../../frontend/web/tests/helpers/browser-rpc-fixture.mjs'

async function until(predicate, label) {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`)
    await delay(10)
  }
}

async function peer(baseUrl, capabilityToken, coreToken, sockets) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/rpc', [websocketProtocol, tokenProtocolPrefix + capabilityToken])
  sockets.push(socket)
  const events = [], closes = []
  socket.on('message', data => {
    const value = JSON.parse(String(data))
    if (value.method === 'session.event') events.push(value.params)
  })
  socket.on('close', (code, reason) => closes.push({ code, reason: String(reason) }))
  await once(socket, 'open')
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error(`Timeout ${method}`)) }, 5000)
    const receive = data => {
      const reply = JSON.parse(String(data))
      if (reply.id !== id) return
      clearTimeout(timer)
      socket.off('message', receive)
      if (reply.error) reject(new Error(JSON.stringify(reply.error)))
      else resolve(reply.result)
    }
    socket.on('message', receive)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  await request('initialize', { protocolVersion: 2, runtimeOrigin: 'mon', clientName: 'multi-session-regression',
    clientVersion: '1', capabilities: [], coreToken })
  return { events, closes, request }
}

test('two concurrent tool sessions retain independent channels through account refresh while legacy peers progress',
  { timeout: 90000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden-multi-session-refresh-'))
    let holdBrowserToken = false
    const pendingProfiles = [], sockets = [], models = []
    const core = createServer((request, response) => {
      const token = request.headers.authorization
      const userId = token === 'Token account-b' ? '202'
        : ['Token account-a', 'Token account-a-peer'].includes(token) ? '101' : undefined
      if (!userId) { response.writeHead(401).end(); return }
      if (holdBrowserToken && token === 'Token account-a' && pendingProfiles.length === 0) pendingProfiles.push(response)
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: userId }))
    })
    core.listen(0, '127.0.0.1')
    await once(core, 'listening')
    const coreBaseUrl = `http://127.0.0.1:${core.address().port}`
    const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0',
      EDEN_AGENT_DATA_ROOT: path.join(root, 'storage'),
      EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(root, 'terminal-settings.json'),
    }), coreBaseUrl }
    const runtimes = new AccountRuntimes(config)
    const http = createServer((_, response) => response.end('fixture'))
    const websocket = attachWebsocket(http, config, token => runtimes.resolve(token))
    let browser
    try {
      await runtimes.start()
      http.listen(0, '127.0.0.1')
      await once(http, 'listening')
      const baseUrl = `http://127.0.0.1:${http.address().port}`
      browser = await browserRpcFixture({ baseUrl, capabilityToken: config.token, origin: 'mon', coreToken: 'account-a' })
      const received = [], statuses = []
      await browser.subscribe(event => received.push(event), connected => statuses.push(connected))
      await until(() => statuses.includes(true), 'browser connection')
      const connectedAt = Date.now()
      const sameAccount = await peer(baseUrl, config.token, 'account-a-peer', sockets)
      const otherAccount = await peer(baseUrl, config.token, 'account-b', sockets)
      const runtime = await runtimes.resolve('account-a')
      assert.equal(await runtimes.resolve('account-a-peer'), runtime, 'Two credentials of the same account share a runtime')
      const sessions = []
      for (const name of ['first', 'second']) {
        const session = await browser.transport.rpcRequest('session.create', { title: name })
        const folder = path.join(root, name)
        await mkdir(folder)
        await runtime.services.workspace.forSession(session.id).switch(folder)
        const model = await recordedModel([
          { tool: 'write_file', input: { path: `${name}.txt`, content: name, createOnly: true } },
          { text: `${name.toUpperCase()}_TOOL_COMPLETED` },
        ])
        models.push(model)
        runtime.services.models.bind(session.id, { model: model.config, entityId: 1, label: name })
        sessions.push({ ...session, name })
      }
      // Deliberately different per-session sequence offsets before both tools run.
      await browser.transport.rpcRequest('session.rename', { sessionId: sessions[0].id, title: 'first renamed' })
      const privateSession = await otherAccount.request('session.create', { title: 'Other account' })
      for (const session of sessions)
        await browser.transport.rpcRequest('turn.start', { sessionId: session.id, text: `write ${session.name}`, attachments: [] })
      const permission = session => runtime.services.permissions.list(session.id).find(value => value.state === 'pending')
      await until(() => sessions.every(permission), 'both tools awaiting approval concurrently')
      await sameAccount.request('ping')
      assert.ok(sessions.every(session => received.some(event => event.sessionId === session.id && event.eventType === 'permission.requested')))
      holdBrowserToken = true
      await delay(Math.max(0, 31000 - (Date.now() - connectedAt)))
      const refreshed = Promise.all([browser.transport.rpcRequest('ping', {}),
        ...sessions.map(session => browser.transport.rpcRequest('session.read', { sessionId: session.id }))])
      // Observe cleanup-time rejection if an assertion fails before the awaited result below.
      void refreshed.catch(() => {})
      await until(() => pendingProfiles.length === 1, 'one independently held browser connection validation')
      const before = received.length
      // Another connection to the SAME runtime must remain usable during this wait.
      await sameAccount.request('session.rename', { sessionId: sessions[1].id, title: 'peer remains live' })
      await otherAccount.request('session.rename', { sessionId: privateSession.id, title: 'other account remains live' })
      for (const session of sessions) runtime.services.permissions.resolve(permission(session).id, true)
      await Promise.all(sessions.map(session => runtime.services.sessions.waitForIdle(session.id)))
      await sameAccount.request('ping')
      await otherAccount.request('ping')
      const pending = []
      const delivered = new Set(received.map(event => event.id))
      for (const session of sessions) {
        const history = runtime.services.repository.events.list(session.id, '0', 1000)
        const queued = history.filter(event => !delivered.has(event.id))
        assert.ok(history.some(event => event.kind === 'operation.completed'))
        assert.ok(history.some(event => event.kind === 'turn.completed'))
        pending.push(...queued)
        assert.equal(await readFile(path.join(runtime.services.workspace.forSession(session.id).root(), `${session.name}.txt`), 'utf8'), session.name)
        assert.deepEqual(sameAccount.events.filter(event => event.sessionId === session.id).map(event => event.id), history.map(event => event.id),
          'Peer connection must receive each completed tool session before the browser refresh finishes')
      }
      await until(() => received.slice(before).some(event => event.eventType === 'turn.completed'),
        'a session channel delivers completed work while another connection is awaiting verification')
      assert.ok(otherAccount.events.some(event => event.sessionId === privateSession.id && event.payload.title === 'other account remains live'))
      assert.equal(pendingProfiles.length, 1, 'Only the selected connection waits; sibling authentication is independent')
      holdBrowserToken = false
      for (const response of pendingProfiles.splice(0))
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: '101' }))
      await refreshed
      await until(() => pending.every(event => received.some(value => value.id === event.id)), 'both session buffers delivered')
      await sameAccount.request('ping')
      assert.deepEqual(new Set(received.map(event => event.id)), new Set(sameAccount.events.map(event => event.id)),
        'Independent session channels preserve all durable events; cross-session ordering is intentionally unconstrained')
      for (const [index, session] of sessions.entries()) {
        const history = await browser.transport.rpcRequest('event.list', { sessionId: session.id, afterSeq: '0', limit: 1000 })
        const live = received.filter(event => event.sessionId === session.id)
        assert.deepEqual(live.map(event => event.id), history.items.map(event => event.id), 'No missing or duplicate events within a session')
        for (let offset = 1; offset < live.length; offset++)
          assert.equal(BigInt(live[offset].seq), BigInt(live[offset - 1].seq) + 1n)
        assert.equal(live.filter(event => event.eventType === 'operation.started' && event.payload.name === 'write_file').length, 1)
        assert.ok(live.some(event => event.payload.message?.role === 'assistant'
          && JSON.stringify(event.payload.message.content).includes(`${session.name.toUpperCase()}_TOOL_COMPLETED`)))
        assert.equal(models[index].requests.length, 2, 'No tool/model replay after validation')
      }
      assert.ok(received.every(event => sessions.some(session => session.id === event.sessionId)))
      assert.ok(sameAccount.events.every(event => sessions.some(session => session.id === event.sessionId)))
      assert.ok(otherAccount.events.every(event => event.sessionId === privateSession.id), 'Different account events never cross runtimes')
      assert.deepEqual(statuses, [true])
      assert.deepEqual(sameAccount.closes, [])
      assert.deepEqual(otherAccount.closes, [])
      console.log(JSON.stringify({ stage: 'multi-session-regression-passed', node: process.version,
        accounts: 2, connections: 5, concurrentToolSessions: 2,
        bufferedBySession: sessions.map(session => ({ name: session.name, events: pending.filter(event => event.sessionId === session.id).length })),
        connectionStates: statuses, peerProgressDuringRefresh: true, crossAccountLeak: false,
        toolExecutions: 2, modelRequests: models.map(model => model.requests.length) }))
    } finally {
      holdBrowserToken = false
      for (const response of pendingProfiles.splice(0)) response.destroy()
      await browser?.close()
      for (const socket of sockets) socket.terminate()
      for (const socket of websocket.clients) socket.terminate()
      websocket.close()
      http.closeAllConnections()
      await new Promise(resolve => http.close(resolve))
      await runtimes.close()
      for (const model of models) await model.close()
      core.closeAllConnections()
      await new Promise(resolve => core.close(resolve))
      assert.equal(path.dirname(root), tmpdir(), 'Cleanup stays in the OS temporary directory')
      await rm(root, { recursive: true, force: true })
    }
  })
