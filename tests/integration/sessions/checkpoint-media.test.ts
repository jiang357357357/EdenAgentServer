import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import type { RuntimeCheckpoint, JsonValue } from '@eden/api'
import { createRuntime } from '@eden/runtime-pi'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, runtimeCallbacks } from '../../../src/modules/sessions/index.ts'
import { ActorCheckpointRepository } from '../../../src/modules/actors/checkpoint-repository.ts'
import { recoverCheckpointMedia } from '../../../src/modules/tool-results/checkpoint-media.ts'

const image = { type: 'image' as const, mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' }
const broken = { ...image, data: 'iVBORw0K[宿主标识已隐藏]invalid' }
const toolName = 'mcp__windows_mcp__desktop__snapshot'
const entry = (picture: typeof image | typeof broken) => ({ type: 'message', id: 'fixture-entry', parentId: null,
  timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolName, toolCallId: 'fixture-call', timestamp: 0,
    isError: false, content: [{ type: 'text', text: '{}' }, picture] } })

test('QQ result reduction leaves a user image intact through tool continuation, persistence and runtime restart', async t => {
  const database = new EdenDatabase(':memory:', 'local'); t.after(() => database.close())
  const sessions = new SessionRepository(database, 'local'), session = sessions.create('media regression'), turnId = randomUUID()
  const model = await recordedModel([{ tool: 'read_qq_action', input: {} }, { text: '图片已收到' }, { text: '重启后仍可读取图片' }])
  t.after(() => model.close())
  const options = { sessionId: session.id, systemPrompt: '', model: model.config,
    tools: [{ name: 'read_qq_action', revision: 'eden.qq.actions.v3', description: 'fixture', parameters: { type: 'object' },
      async execute() { return { request_id: 'fixture-host-trace', result: { folder_id: 0, file_id: image.data, message_id: 123 } } } }],
    callbacks: runtimeCallbacks(sessions, { id: randomUUID(), sessionId: session.id, turnId, text: '图片', state: 'running' }) }
  const runtime = createRuntime(options)
  await runtime.prompt('读取图片', [image])
  const stored = database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(session.id)!
  assert.match(String(stored.checkpoint_json), /iVBORw0KGgoAAAANS/)
  const restored = createRuntime({ ...options, checkpoint: sessions.checkpoint(session.id)! })
  await restored.prompt('继续')
  assert.equal(model.requests.length, 3)
  for (const request of model.requests) assert.ok(JSON.stringify(request).includes(`data:image/png;base64,${image.data}`))
  const actor = new ActorCheckpointRepository(sessions)
  actor.save(session.id, 1, turnId, sessions.checkpoint(session.id)!)
  assert.ok(JSON.stringify(actor.read(session.id, 1)).includes(image.data))
})

test('a corrupt MCP image is restored from its exact raw audit receipt without rewriting the read checkpoint', async t => {
  const database = new EdenDatabase(':memory:', 'local'); t.after(() => database.close())
  const sessions = new SessionRepository(database, 'local'), session = sessions.create('restore media'), turnId = randomUUID()
  const callbacks = runtimeCallbacks(sessions, { id: randomUUID(), sessionId: session.id, turnId, text: 'fixture', state: 'running' })
  await callbacks.beforeTool!(toolName, 'fixture-call', 'mcp:fixture', {})
  await callbacks.afterTool!('fixture-call', { content: [image] }, false, 'completed')
  const snapshot: RuntimeCheckpoint = { format: 'eden.pi-harness.v1', runtimeVersion: '0.82.0', sessionId: session.id,
    createdAt: new Date(0).toISOString(), entries: [entry(broken)] }
  database.connection.prepare('INSERT INTO runtime_checkpoints VALUES(?,?,?)').run(session.id, JSON.stringify(snapshot), 0)
  const restored = sessions.checkpoint(session.id)!
  assert.ok(JSON.stringify(restored).includes(image.data)); assert.ok(!JSON.stringify(restored).includes(broken.data))
  assert.equal(String(database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(session.id)!.checkpoint_json), JSON.stringify(snapshot))
  const actor = new ActorCheckpointRepository(sessions)
  actor.save(session.id, 1, turnId, restored)
  database.connection.prepare('UPDATE actor_checkpoints SET checkpoint_json=? WHERE session_id=?').run(JSON.stringify(snapshot), session.id)
  assert.ok(JSON.stringify(actor.read(session.id, 1)).includes(image.data))
  assert.throws(() => sessions.saveCheckpoint(snapshot, turnId), /历史图片数据损坏/)
})

test('missing, mismatched and ambiguous audit receipts never supply a guessed image', () => {
  const snapshot: RuntimeCheckpoint = { format: 'eden.pi-harness.v1', runtimeVersion: '0.82.0', sessionId: 'fixture',
    createdAt: new Date(0).toISOString(), entries: [entry(broken)] }
  const receipt = (name = toolName, call = 'fixture-call') => ({ message: { role: 'toolResult', toolName: name,
    toolCallId: call, details: { content: [image] } } })
  for (const receipts of [[], [receipt(toolName, 'wrong')], [receipt('mcp__other')], [receipt(), receipt()]] as JsonValue[][]) {
    assert.ok(JSON.stringify(recoverCheckpointMedia(snapshot, receipts)).includes(broken.data))
  }
  assert.ok(JSON.stringify(snapshot).includes(broken.data))
})

test('legacy SDK events restore missing audit images and reject ambiguous or unrelated event matches', t => {
  const database = new EdenDatabase(':memory:', 'local'); t.after(() => database.close())
  const sessions = new SessionRepository(database, 'local'), session = sessions.create('event image recovery')
  const snapshot: RuntimeCheckpoint = { format: 'eden.pi-harness.v1', runtimeVersion: '0.82.0', sessionId: session.id,
    createdAt: new Date(0).toISOString(), entries: [entry(broken)] }
  database.connection.prepare('INSERT INTO runtime_checkpoints VALUES(?,?,?)').run(session.id, JSON.stringify(snapshot), 0)
  const payload = { toolName, toolCallId: 'fixture-call', result: { content: [image] } }
  sessions.events.append(session.id, null, 'agent.tool_execution_end', { ...payload, toolCallId: 'unrelated-call' })
  assert.throws(() => sessions.checkpoint(session.id), /历史图片数据损坏/)
  sessions.events.append(session.id, null, 'agent.tool_execution_end', payload)
  assert.ok(JSON.stringify(sessions.checkpoint(session.id)).includes(image.data))
  sessions.events.append(session.id, null, 'agent.tool_execution_end', payload)
  assert.throws(() => sessions.checkpoint(session.id), /历史图片数据损坏/)
})
