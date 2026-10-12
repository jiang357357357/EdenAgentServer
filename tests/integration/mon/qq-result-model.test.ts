import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createIsolatedRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'
import { runtimeCallbacks } from '../../../src/modules/sessions/index.ts'
import { ActorCheckpointRepository } from '../../../src/modules/actors/checkpoint-repository.ts'
import { qqResultFixture, rawTid } from './qq-result-fixture.ts'
import type { JsonValue } from '@eden/api'

const runtimePolicy = process.env.EDEN_TEST_COMPILED_RUNTIME === '1'
  ? { entry: new URL('../../../../dist/server/runtime-process.mjs', import.meta.url) } : {}

test('real child model sees no platform receipt IDs, can delete by reference and restores legacy history privately', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const deletion = { tool: 'execute_qq_action', input: { bot_id: '42', action: 'delete_qzone_msg', params: { tid: 'pending' } } }
  const model = await recordedModel([
    { tool: 'execute_qq_action', input: { bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } } },
    deletion, { text: '发布后已删除' }, { text: '历史恢复成功' }, { text: '已发布并删除，没有其他操作。' },
  ])
  t.after(() => model.close())
  const input = { id: randomUUID(), sessionId: f.session.id, turnId: f.turnId, text: '发布后删除', state: 'running' }
  const durable = runtimeCallbacks(f.sessions, input)
  const runtime = createIsolatedRuntime({ sessionId: f.session.id, systemPrompt: 'fixture', model: model.config, tools: f.tools,
    callbacks: { ...durable, afterTool: async (callId, result, failed, outcome) => {
      await durable.afterTool!(callId, result, failed, outcome)
      if ((result as { action?: string }).action === 'send_qzone_msg') {
        deletion.input.params.tid = (f.tool('execute_qq_action').modelResult!(result) as { result: { tid: string } }).result.tid
      }
    } } }, runtimePolicy)
  t.after(() => runtime.dispose())
  await runtime.prompt(input.text)
  assert.equal(model.requests.length, 3)
  for (const request of model.requests) assert.doesNotMatch(JSON.stringify(request), new RegExp(rawTid))
  assert.match(JSON.stringify(model.requests[1]), /qqref:qzone:/)
  assert.equal(f.sent.find(item => item.action === 'delete_qzone_msg')!.params.tid, rawTid)
  const audit = f.database.connection.prepare('SELECT result_json FROM tool_operations WHERE tool_name=?').all('execute_qq_action')
  assert.ok(audit.some(row => String(row.result_json).includes(rawTid)))
  const legacy = await runtime.snapshot()
  for (const entry of legacy.entries) {
    const value = entry as { message?: { role: string; toolName?: string; content: JsonValue[]; details?: JsonValue } }
    if (value.message?.role === 'toolResult' && value.message.toolName === 'execute_qq_action') {
      value.message.content = [{ type: 'text', text: JSON.stringify({ action: 'send_qzone_msg', request_id: 'legacy-trace', result: { tid: rawTid } }) }]
      value.message.details = { tid: rawTid }
    }
    if (value.message?.role === 'assistant') value.message.content.push({ type: 'text', text: `说说ID：${rawTid}` })
  }
  f.sessions.saveCheckpoint(legacy, f.turnId)
  const stored = f.database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(f.session.id)!
  assert.match(String(stored.checkpoint_json), new RegExp(rawTid))
  const actorCheckpoints = new ActorCheckpointRepository(f.sessions)
  actorCheckpoints.save(f.session.id, 1, f.turnId, legacy)
  assert.doesNotMatch(JSON.stringify(actorCheckpoints.read(f.session.id, 1)), new RegExp(rawTid))
  const actorStored = f.database.connection.prepare('SELECT checkpoint_json FROM actor_checkpoints WHERE session_id=?').get(f.session.id)!
  assert.match(String(actorStored.checkpoint_json), new RegExp(rawTid))
  const restored = createIsolatedRuntime({ sessionId: f.session.id, systemPrompt: 'fixture', model: model.config,
    tools: f.tools, checkpoint: f.sessions.checkpoint(f.session.id)!, callbacks: callbacks().handlers }, runtimePolicy)
  t.after(() => restored.dispose())
  await restored.prompt('继续')
  assert.equal(model.requests.length, 4)
  assert.doesNotMatch(JSON.stringify(model.requests[3]), new RegExp(`${rawTid}|legacy-trace`))
  await restored.compact()
  assert.equal(model.requests.length, 5)
  assert.doesNotMatch(JSON.stringify(model.requests[4]), new RegExp(`${rawTid}|legacy-trace`))
})

test('failed model projection stops the child after durable raw audit, without another model request or platform write', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  f.database.connection.exec("CREATE TRIGGER reject_qq_reference BEFORE INSERT ON qq_action_references BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  const model = await recordedModel([{ tool: 'execute_qq_action', input: { bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } } },
    { text: 'must not reach the model again' }])
  t.after(() => model.close())
  const audit: JsonValue[] = []
  const runtime = createIsolatedRuntime({ sessionId: f.session.id, systemPrompt: 'fixture', model: model.config, tools: f.tools,
    callbacks: { ...callbacks().handlers, afterTool: async (_callId, result) => { audit.push(result) } } }, runtimePolicy)
  t.after(() => runtime.dispose())
  await assert.rejects(runtime.prompt('publish'), /保存失败|persistence|fixture failure/)
  assert.equal(model.requests.length, 1)
  assert.equal(f.sent.filter(item => item.action === 'send_qzone_msg').length, 1)
  assert.match(JSON.stringify(audit), new RegExp(rawTid))
})
