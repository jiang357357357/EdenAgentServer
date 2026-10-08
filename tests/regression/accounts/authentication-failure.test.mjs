import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { tokenProtocolPrefix, websocketProtocol } from '@eden/api'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'

async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`)
    await delay(10)
  }
}

async function connect(baseUrl, capabilityToken, coreToken, sockets) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/rpc', [websocketProtocol, tokenProtocolPrefix + capabilityToken])
  sockets.push(socket)
  const events = [], closes = [], errors = []
  socket.on('message', data => {
    const value = JSON.parse(String(data))
    if (value.method === 'session.event') events.push(value.params)
  })
  socket.on('close', (code, reason) => closes.push({ code, reason: String(reason) }))
  socket.on('error', error => errors.push(error))
  await once(socket, 'open')
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = randomUUID()
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', receive)
      socket.off('close', closed)
      socket.off('error', failed)
    }
    const failed = error => { cleanup(); reject(error) }
    const closed = (code, reason) => failed(new Error(`WebSocket closed ${code}: ${String(reason)}`))
    const receive = data => {
      const value = JSON.parse(String(data))
      if (value.id !== id) return
      cleanup()
      if (value.error) reject(new Error(JSON.stringify(value.error)))
      else resolve(value.result)
    }
    const timer = setTimeout(() => failed(new Error(`Timeout ${method}`)), 15000)
    socket.on('message', receive)
    socket.once('close', closed)
    socket.once('error', failed)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), error => { if (error) failed(error) })
  })
  await request('initialize', { protocolVersion: 2, runtimeOrigin: 'mon', clientName: 'authentication-failure-regression',
    clientVersion: '1', capabilities: [], coreToken })
  return { socket, events, closes, errors, request, initializedAt: Date.now() }
}

async function scenario(t, failure) {
  const root = await mkdtemp(path.join(tmpdir(), `eden-authentication-${failure}-`))
  const sockets = [], pendingProfiles = []
  let hold = false, heldAt = 0
  const core = createServer((request, response) => {
    if (request.url !== '/api/users/me/profile/') { response.writeHead(404).end(); return }
    const token = request.headers.authorization
    const id = token === 'Token account-b' ? '202'
      : ['Token account-a', 'Token account-a-peer'].includes(token) ? '101' : undefined
    if (!id) { response.writeHead(401).end(); return }
    if (hold && token === 'Token account-a') {
      heldAt ||= Date.now()
      pendingProfiles.push(response)
    } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }))
  })
  core.listen(0, '127.0.0.1')
  await once(core, 'listening')
  const coreBaseUrl = `http://127.0.0.1:${core.address().port}`
  const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0',
    EDEN_AGENT_DATA_ROOT: path.join(root, 'storage'),
    EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(root, 'terminal-settings.json'),
  }), coreBaseUrl }
  const runtimes = new AccountRuntimes(config)
  const http = createServer((_, response) => response.end('temporary authentication regression host'))
  const websocket = attachWebsocket(http, config, token => runtimes.resolve(token))
  try {
    await runtimes.start()
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const baseUrl = `http://127.0.0.1:${http.address().port}`
    const denied = await connect(baseUrl, config.token, 'account-a', sockets)
    const sameAccount = await connect(baseUrl, config.token, 'account-a-peer', sockets)
    const otherAccount = await connect(baseUrl, config.token, 'account-b', sockets)
    const firstSessions = [], secondSessions = []
    for (let index = 0; index < 2; index++) {
      firstSessions.push(await denied.request('session.create', { title: `A-${index}` }))
      secondSessions.push(await otherAccount.request('session.create', { title: `B-${index}` }))
    }
    await denied.request('session.rename', { sessionId: firstSessions[0].id, title: 'A-offset' })
    await sameAccount.request('ping')
    await otherAccount.request('ping')
    const originalIds = new Set(denied.events.map(event => event.id))
    const originalCount = denied.events.length
    hold = true
    await delay(Math.max(0, 31000 - (Date.now() - denied.initializedAt)))
    const refreshOutcome = denied.request('ping').then(
      result => ({ fulfilled: true, result }), error => ({ fulfilled: false, error: String(error) }))
    await until(() => pendingProfiles.length === 1, 'one shared delayed Core revalidation')

    for (const [index, session] of firstSessions.entries())
      await sameAccount.request('session.rename', { sessionId: session.id, title: `A-queued-${index}` })
    for (const [index, session] of secondSessions.entries())
      await otherAccount.request('session.rename', { sessionId: session.id, title: `B-during-refresh-${index}` })
    await sameAccount.request('ping')
    await otherAccount.request('ping')
    await delay(250)
    const heldEvents = sameAccount.events.filter(event => !originalIds.has(event.id))
    assert.ok(firstSessions.every(session => heldEvents.some(event => event.sessionId === session.id)), 'Both A sessions generated held live events')
    assert.equal(denied.events.length, originalCount, 'No queued event is sent while Core verification is pending')
    assert.equal(pendingProfiles.length, 1, 'Concurrent session publications share the verification')
    assert.equal(sameAccount.closes.length, 0)
    assert.equal(otherAccount.closes.length, 0)
    const delayedMs = Date.now() - heldAt
    assert.ok(delayedMs >= 250)

    hold = false
    for (const response of pendingProfiles.splice(0)) {
      if (failure === '401') response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'fixture revoked' }))
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: '202' }))
    }
    await until(() => denied.closes.length === 1, 'authentication failure closes only its connection')
    const outcome = await refreshOutcome
    assert.equal(outcome.fulfilled, false)
    assert.deepEqual(denied.closes, [{ code: 1008, reason: 'Core account authentication failed' }])
    assert.equal(denied.events.length, originalCount, 'A failed verification cannot release any held event')
    assert.ok(heldEvents.every(event => !denied.events.some(value => value.id === event.id)))

    for (const [index, session] of firstSessions.entries())
      await sameAccount.request('session.rename', { sessionId: session.id, title: `A-after-failure-${index}` })
    for (const [index, session] of secondSessions.entries())
      await otherAccount.request('session.rename', { sessionId: session.id, title: `B-after-failure-${index}` })
    await sameAccount.request('ping')
    await otherAccount.request('ping')
    for (const [index, session] of firstSessions.entries())
      assert.equal((await sameAccount.request('session.read', { sessionId: session.id })).title, `A-after-failure-${index}`)
    for (const [index, session] of secondSessions.entries())
      assert.equal((await otherAccount.request('session.read', { sessionId: session.id })).title, `B-after-failure-${index}`)
    await assert.rejects(otherAccount.request('session.read', { sessionId: firstSessions[0].id }), /会话不存在|不属于|Session not found/)
    await assert.rejects(sameAccount.request('session.read', { sessionId: secondSessions[0].id }), /会话不存在|不属于|Session not found/)
    assert.ok(denied.events.every(event => firstSessions.some(session => session.id === event.sessionId)))
    assert.ok(sameAccount.events.every(event => firstSessions.some(session => session.id === event.sessionId)))
    assert.ok(otherAccount.events.every(event => secondSessions.some(session => session.id === event.sessionId)))
    assert.equal(denied.events.length, originalCount)
    for (const client of [sameAccount, otherAccount]) {
      assert.equal(client.closes.length, 0)
      assert.equal(client.errors.length, 0)
      assert.equal(client.socket.readyState, WebSocket.OPEN)
    }
    t.diagnostic(JSON.stringify({ scenario: failure, node: process.version, accounts: 2, connections: 3, sessions: 4,
      elapsedMs: Date.now() - denied.initializedAt, validationDelayedMs: delayedMs, heldEvents: heldEvents.length,
      deniedCloseCode: denied.closes[0].code, heldEventsDelivered: 0, unaffectedConnections: 2, crossAccountLeak: false, ui: false }))
  } finally {
    hold = false
    for (const response of pendingProfiles.splice(0)) response.destroy()
    for (const socket of sockets) socket.terminate()
    for (const socket of websocket.clients) socket.terminate()
    await new Promise(resolve => websocket.close(resolve))
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    await runtimes.close()
    core.closeAllConnections()
    await new Promise(resolve => core.close(resolve))
    assert.equal(path.dirname(root), tmpdir(), 'Cleanup remains inside the OS temporary directory')
    await rm(root, { recursive: true, force: true })
  }
}

describe('real account revalidation failure with multiple sessions and connections', { concurrency: 2 }, () => {
  for (const failure of ['401', 'identity-change']) {
    test(`slow Core verification followed by ${failure} releases no buffered event and closes only its connection`,
      { timeout: 60000 }, t => scenario(t, failure))
  }
})
