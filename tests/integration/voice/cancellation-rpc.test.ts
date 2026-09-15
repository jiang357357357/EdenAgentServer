import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { websocketProtocol, tokenProtocolPrefix } from '@eden/api'
import { startServer } from '../../../src/bootstrap/container.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'

function rpc(client: WebSocket, method: string, params: unknown): Promise<{ result: unknown; error: unknown }> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('message', listener); reject(new Error(`Timeout: ${method}`)) }, 5000)
    const listener = (data: Buffer) => {
      const response = JSON.parse(data.toString())
      if (response.id !== id) return
      clearTimeout(timer); client.off('message', listener); resolve(response)
    }
    client.on('message', listener)
    client.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

test('same WebSocket cancels pending GSV synthesis without waiting for its response', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-tts-cancel-rpc-'))
  let started!: () => void, disconnected!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const closed = new Promise<void>(resolve => { disconnected = resolve })
  const upstream = createServer((_, response) => { response.on('close', disconnected); started() })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  const config = loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' })
  const server = await startServer(config)
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, [websocketProtocol, tokenProtocolPrefix + config.token])
  t.after(async () => { client.terminate(); await server.close(); await rm(root, { recursive: true, force: true }) })
  await once(client, 'open')
  assert.equal((await rpc(client, 'initialize', { protocolVersion: 2, runtimeOrigin: 'local', clientName: 'tts-test', clientVersion: '1', capabilities: [] })).error, null)
  const session = await rpc(client, 'session.create', { title: 'Temporary speech cancellation' })
  assert.equal(session.error, null)
  const sessionId = (session.result as { id: string }).id
  const address = upstream.address() as { port: number }
  assert.equal((await rpc(client, 'voice.tts.config.update', { serviceUrl: `http://127.0.0.1:${address.port}`, roleId: 'test' })).error, null)
  const requestId = randomUUID()
  const synthesis = rpc(client, 'voice.tts.synthesize', { requestId, sessionId, messageId: 'test', segmentGroupId: 'test:0', groupIndex: 0, sequence: 0, text: '取消测试', configId: 1, mode: 'all' })
  await ready
  // A second consumer on the same socket must register before cancellation too.
  const sharedRequestId = randomUUID()
  const shared = rpc(client, 'voice.tts.synthesize', { requestId: sharedRequestId, sessionId, messageId: 'other', segmentGroupId: 'other:0', groupIndex: 0, sequence: 0, text: '取消测试', configId: 1, mode: 'all' })
  assert.equal((await rpc(client, 'voice.tts.list_segments', { sessionId })).error, null)
  const cancellation = await rpc(client, 'voice.tts.cancel', { requestId, sessionId })
  assert.equal(cancellation.error, null)
  assert.deepEqual(cancellation.result, { cancelled: true })
  assert.match(JSON.stringify((await synthesis).error), /cancelled/)
  assert.deepEqual((await rpc(client, 'voice.tts.cancel', { requestId: sharedRequestId, sessionId })).result, { cancelled: true })
  assert.match(JSON.stringify((await shared).error), /cancelled/)
  await closed
  assert.deepEqual((await rpc(client, 'voice.tts.list_segments', { sessionId })).result, [])
})
