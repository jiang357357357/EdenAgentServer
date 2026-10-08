import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { EdenDatabase } from '@eden/store'
import { tokenProtocolPrefix, websocketProtocol, type JsonValue } from '@eden/api'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import type { RuntimeScope } from '../../../src/bootstrap/runtime-scope.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5) }
  assert.fail('Timed out waiting for isolated session delivery')
}

test('independent real session sockets preserve FIFO, prioritize cancellation, replay handoff and constrain scope', async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local')
  const sessions = new SessionService(repository, undefined)
  const first = repository.create('First'), second = repository.create('Second')
  const config = loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'local', EDEN_AGENT_PORT: '0' })
  let release!: () => void
  let held = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const runtime = { config, services: { repository, sessions }, routes: {
    'session.set_participants': async (params: JsonValue) => {
      order.push('first started'); await held; order.push('first completed')
      return repository.read((params as { sessionId: string }).sessionId)
    },
    'turn.cancel': (params: JsonValue) => {
      order.push('cancel'); return { sessionId: (params as { sessionId: string }).sessionId, cancellationRequested: true }
    },
  } } as unknown as RuntimeScope
  const http = createServer((_, response) => response.end('healthy'))
  const websocket = attachWebsocket(http, config, async () => runtime)
  const sockets: WebSocket[] = []
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address()
  assert.ok(address && typeof address === 'object')
  async function peer(channel: Record<string, unknown> = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${(address as { port: number }).port}/rpc`, [websocketProtocol, tokenProtocolPrefix + config.token])
    sockets.push(socket)
    const notifications: { method: string; params: { sessionId: string; seq: string; afterSeq: string } }[] = []
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
    socket.on('message', data => {
      const value = JSON.parse(String(data))
      if (value.id) {
        const waiter = pending.get(value.id); pending.delete(value.id)
        if (value.error) waiter?.reject(new Error(value.error.message)); else waiter?.resolve(value.result)
      } else notifications.push(value)
    })
    socket.on('close', () => { for (const waiter of pending.values()) waiter.reject(new Error('Peer connection closed')); pending.clear() })
    await once(socket, 'open')
    const request = (method: string, params: unknown = {}) => new Promise<unknown>((resolve, reject) => {
      const id = randomUUID(); pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    await request('initialize', { protocolVersion: 2, runtimeOrigin: 'local', clientName: 'isolation-test', clientVersion: '1', capabilities: [], ...channel })
    return { socket, request, notifications }
  }
  try {
    const control = await peer({ eventMode: 'discovery' })
    const legacy = await peer()
    const a = await peer({ sessionId: first.id })
    const b = await peer({ sessionId: second.id })
    const slow = a.request('session.set_participants', { sessionId: first.id, participants: [] })
    await until(() => order.includes('first started'))
    let renamed = false
    const later = a.request('session.rename', { sessionId: first.id, title: 'After slow' }).then(() => { renamed = true })
    await b.request('session.rename', { sessionId: second.id, title: 'Independent' })
    await a.request('turn.cancel', { sessionId: first.id })
    assert.deepEqual(order, ['first started', 'cancel'])
    assert.equal(renamed, false, 'Ordinary requests on one session retain their order')
    await assert.rejects(b.request('session.read', { sessionId: first.id }), /bound to this connection/)
    await assert.rejects(b.request('session.create', { title: 'Forbidden', sessionId: second.id }), /bound to this connection/)
    await assert.rejects(b.request('session.list', {}), /bound to this connection/)
    assert.deepEqual(await b.request('ping'), { pong: true })
    release(); await Promise.all([slow, later])
    const newSession = repository.create('Discovery handoff')
    await until(() => control.notifications.some(value => value.params.sessionId === newSession.id))
    const notice = control.notifications.find(value => value.params.sessionId === newSession.id)!
    for (let i = 0; i < 100; i++) repository.events.append(newSession.id, null, 'agent.message_update', { message: { role: 'assistant', content: [{ type: 'text', text: String(i) }] } })
    const discovered = await peer({ sessionId: newSession.id, afterSeq: notice.params.afterSeq })
    await until(() => discovered.notifications.length === 101)
    assert.deepEqual(discovered.notifications.map(value => value.params.seq), Array.from({ length: 101 }, (_, i) => String(i + 1)))
    assert.ok(control.notifications.every(value => value.method === 'session.discovered'), 'No token payloads on control socket')
    assert.equal(control.notifications.filter(value => value.params.sessionId === newSession.id).length, 1)
    await until(() => legacy.notifications.some(value => value.params.sessionId === newSession.id && value.params.seq === '101'))
    assert.ok(a.notifications.every(value => value.params.sessionId === first.id))
    assert.ok(b.notifications.every(value => value.params.sessionId === second.id))
    a.socket.close(1013, 'fixture slow consumer')
    await once(a.socket, 'close')
    await b.request('session.rename', { sessionId: second.id, title: 'Still independent' })
    await until(() => b.notifications.length === 2)
    assert.equal(b.socket.readyState, WebSocket.OPEN)
    const congested = await peer({ sessionId: first.id })
    const serverPeer = [...websocket.clients].at(-1)!
    Object.defineProperty(serverPeer, 'bufferedAmount', { configurable: true, get: () => 5 * 1024 * 1024 })
    const backpressureClose = once(congested.socket, 'close')
    await assert.rejects(congested.request('ping'), /connection closed/)
    assert.equal((await backpressureClose)[0], 1013, 'Actual server sender closes only the congested socket')
    assert.deepEqual(await b.request('ping'), { pong: true })
    held = new Promise<void>(resolve => { release = resolve })
    const overloaded = await peer({ sessionId: first.id })
    const queueClose = once(overloaded.socket, 'close')
    const abandoned = [overloaded.request('session.set_participants', { sessionId: first.id, participants: [] }).catch(() => {})]
    await until(() => order.filter(value => value === 'first started').length === 2)
    for (let i = 0; i < 65; i++) abandoned.push(overloaded.request('session.rename', { sessionId: first.id, title: `Queued ${i}` }).catch(() => {}))
    assert.equal((await queueClose)[0], 1008)
    assert.deepEqual(await b.request('ping'), { pong: true }, 'A saturated session cannot close or delay its sibling')
    release(); await Promise.all(abandoned)
  } finally {
    release()
    for (const socket of sockets) socket.terminate()
    for (const socket of websocket.clients) socket.terminate()
    websocket.close()
    await new Promise<void>(resolve => http.close(() => resolve()))
    database.close()
  }
})
