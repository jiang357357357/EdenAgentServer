import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as yieldIo, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'
import { recordedModel } from '@eden/runtime-pi/testing'
import { tokenProtocolPrefix, websocketProtocol } from '@eden/api'
import type { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

const historySize = 192_392
type Event = { id: string; seq: string; eventType: string; payload: unknown }
type Page = { items: Event[]; hasMore: boolean; nextCursor: string | null }

/** Seed the size of the reported legacy history, without borrowing any user data. */
async function seedHistory(repository: SessionRepository, sessionId: string) {
  const db = repository.database
  const insert = db.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
  const message = { role: 'assistant', content: [{ type: 'text', text: 'recorded history '.repeat(25) }] }
  const partial = JSON.stringify({ messageId: 'historical-message', message,
    assistantMessageEvent: { type: 'text_delta', delta: 'y', partial: message } })
  const complete = JSON.stringify({ messageId: 'historical-message', message })
  let completed = 0
  for (let offset = 0; offset < historySize; offset += 2000) {
    db.transaction(() => {
      for (let index = offset; index < Math.min(offset + 2000, historySize); index++) {
        const final = index % 512 === 511 || index === historySize - 1
        if (final) completed++
        insert.run(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, sessionId, null, index + 2,
          final ? 'agent.message_end' : 'agent.message_update', final ? complete : partial, index + 1)
      }
    })
    await yieldIo()
  }
  return completed
}

async function clientConnection(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [websocketProtocol, tokenProtocolPrefix + token])
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  const notifications: Event[] = []
  const closes: number[] = []
  let sequence = 0
  socket.on('message', data => {
    const message = JSON.parse(String(data))
    if (message.method === 'session.event') notifications.push(message.params as Event)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.on('close', code => {
    closes.push(code)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('History test connection closed'))
    }
    pending.clear()
  })
  await once(socket, 'open')
  const request = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC timed out while reading large history: ${method}`))
    }, 10_000)
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  await request('initialize', { protocolVersion: 2, runtimeOrigin: 'local', clientName: 'history-regression',
    clientVersion: 'test', capabilities: ['session-events'] })
  return { socket, request, notifications, closes }
}

test('192392 historical events remain readable while health, another client and a recorded turn progress',
  { timeout: 180_000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden-history-scale-'))
    const model = await recordedModel([{ text: 'new reply remains available' }])
    const config = { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config }
    const server = await startServer(config)
    let stopped = false
    let health: Promise<void> | undefined
    const sockets: WebSocket[] = []
    t.after(async () => {
      stopped = true
      await health?.catch(() => {})
      for (const socket of sockets) socket.terminate()
      await server.close()
      await model.close()
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
      await rm(root, { recursive: true, force: true })
    })
    const repository = server.sessions.repository
    const session = repository.create('Synthetic legacy history')
    const completed = await seedHistory(repository, session.id)
    const before = Number(repository.database.connection.prepare('SELECT COUNT(*) AS n FROM events').get()?.n)
    assert.equal(before, historySize + 1)
    const freshSession = repository.create('Conversation during historical replay')
    const reader = await clientConnection(server.port, config.token)
    const peer = await clientConnection(server.port, config.token)
    sockets.push(reader.socket, peer.socket)
    const latencies: number[] = []
    let peerPings = 0
    health = (async () => {
      while (!stopped) {
        const start = performance.now()
        const response = await fetch(`http://127.0.0.1:${server.port}/healthz`, { signal: AbortSignal.timeout(5000) })
        assert.equal(response.status, 200)
        await response.arrayBuffer()
        await peer.request('ping', {})
        peerPings++
        latencies.push(performance.now() - start)
        await delay(5)
      }
    })()
    // Observe failures immediately; the original promise remains rejected for the assertion below.
    void health.catch(() => { stopped = true })
    const replayStart = performance.now()
    let afterSeq = '0', seen = 0, pages = 0
    let turnIdle: Promise<void> | undefined
    let turnFinishedAfterPage: number | undefined
    do {
      const page = await reader.request<Page>('event.list', { sessionId: session.id, afterSeq, limit: 1000 })
      for (const event of page.items) {
        assert.equal(BigInt(event.seq), BigInt(afterSeq) + 1n)
        afterSeq = event.seq
        seen++
      }
      pages++
      if (pages === 2) {
        await peer.request('turn.start', { sessionId: freshSession.id, text: 'Please respond', attachments: [], idempotencyKey: 'history-new-turn' })
        turnIdle = server.sessions.waitForIdle(freshSession.id).then(() => { turnFinishedAfterPage = pages })
      }
      if (!page.hasMore) break
    } while (true)
    assert.equal(seen, before, 'Every historical event and its original sequence remains available')
    const replayMs = performance.now() - replayStart
    const messages = await reader.request<Page>('message.list', { sessionId: session.id, limit: 50 })
    assert.equal(messages.items.length, 50)
    assert.equal(messages.hasMore, completed > 50)
    await turnIdle
    assert.ok(turnFinishedAfterPage !== undefined && turnFinishedAfterPage < pages, 'A new turn finishes before historical replay completes')
    const latest = await peer.request<Page>('message.list', { sessionId: freshSession.id, limit: 2 })
    assert.match(JSON.stringify(latest), /new reply remains available/)
    assert.equal(model.requests.length, 1, 'History reads do not rerun the model or tools')
    stopped = true
    await health
    assert.ok(peerPings > 1, 'A second connection and HTTP health must progress during replay')
    assert.deepEqual(reader.closes, [])
    assert.deepEqual(peer.closes, [])
    assert.equal(repository.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE id LIKE '00000000-0000-4000-8000-%'").get()?.n, historySize)
    t.diagnostic(JSON.stringify({ syntheticHistoricalEvents: historySize, pages, replayMs: Math.round(replayMs),
      healthAndPeerSamples: peerPings, worstHealthAndPingMs: Math.round(Math.max(...latencies)),
      preservedHistoricalEvents: historySize, modelCalls: model.requests.length, turnFinishedAfterPage, connectionCloses: 0 }))
  })
