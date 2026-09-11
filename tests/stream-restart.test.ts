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

test('real runtime persists compact events and restart RPC restores exact public stream payloads', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-stream-restart-'))
  const model = await recordedModel([{ text: 'Recorded reply' }])
  const config = { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config }
  let server = await startServer(config)
  context.after(async () => { await server.close(); await model.close(); await rm(root, { recursive: true, force: true }) })
  const session = server.sessions.repository.create('Stream restart')
  const live: DurableEvent[] = []
  server.sessions.repository.events.subscribe(event => live.push(event))
  server.sessions.start(session.id, 'Say something')
  await server.sessions.waitForIdle(session.id)
  const updates = live.filter(event => event.kind === 'agent.message_update')
  assert.ok(updates.length > 0)
  const stored = server.sessions.repository.database.connection.prepare("SELECT payload_json FROM events WHERE kind='agent.message_update'").all()
  assert.ok(stored.every(row => JSON.parse(String(row.payload_json)).messageStorage?.format === 'eden.message.delta.v1'))
  await server.close()
  server = await startServer(config)
  const events = server.sessions.repository.events.list(session.id, '0', 1000)
  assert.deepEqual(events.filter(event => event.kind === 'agent.message_update'), updates)
  const page = await sessionRoutes(server.sessions)['event.list']!({ sessionId: session.id, afterSeq: '0', limit: 1000 })
  assert.ok(!JSON.stringify(page).includes('messageStorage'))
  assert.match(JSON.stringify(page), /Recorded reply/)
  assert.equal(model.requests.length, 1)
})
