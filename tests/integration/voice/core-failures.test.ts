import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EdenDatabase } from '@eden/store'
import { MonClient } from '@eden/integrations'
import { OperationFailure, type VoiceSynthesizeInput } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { MonOperationRepository } from '../../../src/modules/mon/operation-repository.ts'
import { synthesizeMonSpeech } from '../../../src/modules/mon/speech.ts'
import { RpcRouter } from '../../../src/transport/rpc/router.ts'

test('real Core HTTP business failure is failed, opaque server failure remains unknown and RPC carries its cause', async t => {
  let status = 500, body: unknown = { success: false, error_message: 'GSV reference audio missing', error_code: 'tts_reference_missing' }
  const server = createServer((_request, response) => response.writeHead(status).end(JSON.stringify(body)))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const db = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(db, 'mon'), session = sessions.create('speech')
  t.after(async () => { db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const client = new MonClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'fixture'), operations = new MonOperationRepository(sessions)
  const input: VoiceSynthesizeInput = { sessionId: session.id, messageId: 'one', segmentGroupId: 'one', groupIndex: 0, sequence: 0, text: 'test', configId: 1, mode: 'all' }
  const speech = () => synthesizeMonSpeech(client, operations, input, new AbortController().signal)
  await assert.rejects(speech(), error => {
    assert.ok(error instanceof OperationFailure); assert.equal(error.details.outcome, 'failed'); assert.equal(error.details.retryable, false)
    assert.match(error.message, /reference audio missing/); assert.ok(error.cause instanceof Error); return true
  })
  assert.equal(db.connection.prepare('SELECT state FROM mon_operations').get()!.state, 'failed')
  status = 502; body = { detail: 'gateway lost upstream response' }
  await assert.rejects(speech(), error => error instanceof OperationFailure && error.details.outcome === 'unknown' && !error.details.retryable)
  const router = new RpcRouter('mon', { 'fixture.speech': speech as unknown as () => Promise<import('@eden/api').JsonValue> })
  await router.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2, runtimeOrigin: 'mon', clientName: 'fixture', clientVersion: '1', capabilities: [] } })
  const result = await router.dispatch({ jsonrpc: '2.0', id: 2, method: 'fixture.speech', params: {} }) as { error: { data: { status: number; outcome: string; retryable: boolean }; message: string } }
  assert.equal(result.error.data.status, 502); assert.equal(result.error.data.outcome, 'unknown'); assert.equal(result.error.data.retryable, false)
  assert.match(result.error.message, /gateway lost upstream response/)
})
