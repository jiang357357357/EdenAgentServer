import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/bootstrap/container.ts'
import { loadConfig } from '../src/bootstrap/config.ts'
import { recordedModel } from '@eden/runtime-pi/testing'
import { sessionRoutes } from '../src/transport/rpc/session.routes.ts'
import type { DurableEvent } from '@eden/api'

test('request storage survives host restart and audit RPC restores the actual provider payload', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-request-restart-'))
  const model = await recordedModel([{ text: 'First reply' }, { text: 'Second reply' }])
  const config = { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config }
  let server = await startServer(config)
  context.after(async () => { await server.close(); await model.close(); await rm(root, { recursive: true, force: true }) })
  const session = server.sessions.repository.create('Request restart')
  const live: DurableEvent[] = []
  server.sessions.repository.events.subscribe(event => { if (event.kind === 'model.request') live.push(event) })
  server.sessions.start(session.id, 'Synthetic context '.repeat(200))
  await server.sessions.waitForIdle(session.id)
  server.sessions.start(session.id, 'Continue')
  await server.sessions.waitForIdle(session.id)
  assert.equal(live.length, 2)
  const stored = server.sessions.repository.database.connection.prepare("SELECT payload_json FROM events WHERE kind='model.request'").all()
  assert.ok(stored.every(row => JSON.parse(String(row.payload_json)).requestStorage?.format === 'eden.request.content.v1'))
  await server.close()
  server = await startServer(config)
  const replay = server.sessions.repository.events.list(session.id, '0', 1000).filter(event => event.kind === 'model.request')
  assert.deepEqual(replay, live)
  for (let i = 0; i < replay.length; i++) assert.deepEqual((replay[i]!.payload as Record<string, unknown>).payload, model.requests[i])
  const page = await sessionRoutes(server.sessions)['event.list']!({ sessionId: session.id, afterSeq: '0', limit: 1000 })
  assert.ok(!JSON.stringify(page).includes('requestStorage'))
  assert.equal(model.requests.length, 2)
})
