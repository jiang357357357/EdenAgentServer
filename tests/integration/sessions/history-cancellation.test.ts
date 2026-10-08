import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as yieldIo } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'
import { tokenProtocolPrefix, websocketProtocol } from '@eden/api'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

function rpc(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', message); socket.off('close', closed) }
    const closed = () => { cleanup(); reject(new Error('Fixture RPC connection closed')) }
    const message = (raw: Buffer) => {
      const response = JSON.parse(String(raw))
      if (response.id !== id) return
      cleanup()
      if (response.error) reject(new Error(response.error.message))
      else resolve(response.result)
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Fixture RPC timed out: ${method}`)) }, 5000)
    socket.on('message', message); socket.once('close', closed)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

test('disconnecting an actual WebSocket cancels its batched history read while another connection remains usable',
  { timeout: 15_000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden-history-cancel-'))
    const config = loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }, root)
    const server = await startServer(config)
    const sockets: WebSocket[] = []
    const repository = server.sessions.repository
    const original = repository.events.listAsync
    t.after(async () => {
      repository.events.listAsync = original
      for (const socket of sockets) socket.terminate()
      await server.close()
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
      await rm(root, { recursive: true, force: true })
    })
    const session = repository.create('Cancellation fixture')
    const insert = repository.database.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
    repository.database.transaction(() => {
      for (let index = 0; index < 1200; index++) {
        insert.run(randomUUID(), session.id, null, index + 2, 'agent.message_update',
          JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `fixture ${index}` }] } }), index)
      }
    })
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, [websocketProtocol, tokenProtocolPrefix + config.token])
      sockets.push(socket)
      await once(socket, 'open')
      await rpc(socket, 'initialize', { protocolVersion: 2, runtimeOrigin: 'local', clientName: 'history-cancel',
        clientVersion: 'test', capabilities: ['session-events'] })
      return socket
    }
    const reader = await connect(), peer = await connect()
    let began!: () => void, finished!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const completed = new Promise<void>(resolve => { finished = resolve })
    const observed: { signal: AbortSignal | undefined; error?: unknown; returned: boolean } = { signal: undefined, returned: false }
    repository.events.listAsync = async (id, after, limit, signal) => {
      observed.signal = signal
      began()
      try {
        const result = await original.call(repository.events, id, after, limit, signal)
        observed.returned = true
        return result
      } catch (error) {
        observed.error = error
        throw error
      } finally { finished() }
    }
    reader.send(JSON.stringify({ jsonrpc: '2.0', id: 'cancelled-history', method: 'event.list',
      params: { sessionId: session.id, afterSeq: '0', limit: 1000 } }))
    await started
    // Let the real reader advance through multiple I/O turns before closing it.
    await yieldIo()
    await yieldIo()
    reader.terminate()
    await completed
    assert.equal(observed.signal?.aborted, true)
    assert.equal(observed.returned, false, 'The closed connection must not finish building its 1000-event page')
    assert.ok(observed.error instanceof Error)
    assert.equal(observed.error.name, 'AbortError')
    assert.deepEqual(await rpc(peer, 'ping', {}), { pong: true })
    assert.equal(peer.readyState, WebSocket.OPEN)
    assert.equal(repository.database.connection.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id=?').get(session.id)?.n, 1201)
  })
