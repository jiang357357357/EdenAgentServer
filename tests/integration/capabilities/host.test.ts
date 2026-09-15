import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

test('real host uses a reduced default catalog while retaining deferred capabilities for discovery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-capability-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const model = await recordedModel([{ tool: 'list_tools', input: { query: 'manage_plugins' } }, { text: '找到插件开发能力' }])
  t.after(() => model.close())
  const server = await startServer({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config })
  t.after(() => server.close())
  const session = server.sessions.repository.create('工具发现')
  server.sessions.start(session.id, '查找插件开发能力')
  await server.sessions.waitForIdle(session.id)
  const system = JSON.stringify((model.requests[0]!.messages as { role: string; content: unknown }[]).filter(message => message.role === 'system'))
  for (const name of ['eden-memory', 'eden-reminders', 'eden-workspace']) assert.equal(system.split(name).length - 1, 1)
  assert.doesNotMatch(system, /eden-self-awake/)
  assert.doesNotMatch(system, /保存新记忆前检查是否已有相同记录/)
  const all = server.sessions.toolCatalog()
  const exposed = (model.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  assert.ok(all.find(tool => tool.name === 'manage_plugins')?.exposure === 'deferred')
  assert.ok(exposed.includes('list_tools'))
  assert.ok(!exposed.includes('manage_plugins'))
  assert.ok(!exposed.includes('dispatch_due_memos'))
  assert.ok(exposed.length < all.length / 2)
  t.diagnostic(`Registered tools: ${all.length}; default model tools: ${exposed.length}`)
  assert.match(JSON.stringify(model.requests[1]!.messages), /builtin:manage_plugins/)
})
