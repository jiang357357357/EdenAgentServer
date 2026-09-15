import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

test('real host reads the memory guide, approves a write, unloads instructions and retrieves the memory after restart', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-builtin-memory-live-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const model = await recordedModel([
    { tool: 'load_skill', input: { name: 'eden-memory' } },
    { tool: 'remember_memory', input: { content: '临时测试角色偏好薄荷茶', kind: 'preference' } },
    { tool: 'unload_skill', input: { name: 'eden-memory' } }, { text: '已登记' },
    { tool: 'search_memories', input: { query: '薄荷茶' } }, { text: '重启后已找回记忆' },
  ])
  t.after(() => model.close())
  const config = { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config }
  let server = await startServer(config)
  t.after(() => server.close())
  const session = server.sessions.repository.create('基础技能真实链路', [{ assistantId: 1, characterId: 7 }])
  let approvals = 0
  server.sessions.repository.events.subscribe(event => {
    if (event.kind !== 'permission.requested') return
    const request = server.permissions.list(session.id).find(item => item.state === 'pending')!
    approvals++
    assert.equal(request.capability, 'memory.write')
    assert.match(request.resource, /character:7/)
    server.permissions.resolve(request.id, true)
  })
  server.sessions.start(session.id, '按记忆技能记录测试偏好，然后卸载说明。')
  await server.sessions.waitForIdle(session.id)
  assert.equal(approvals, 1)
  assert.equal(server.sessions.faultCount(), 0)
  const toolNames = (index: number) => (model.requests[index]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  assert.deepEqual(toolNames(0), toolNames(1), 'reading instructions does not change interfaces')
  assert.deepEqual(toolNames(0), toolNames(3), 'unloading instructions does not change interfaces')
  assert.match(JSON.stringify(model.requests[1]!.messages), /保存新记忆前检查是否已有相同记录/)
  await server.close()
  server = await startServer(config)
  server.sessions.start(session.id, '查询刚才的测试偏好，不再读取技能。')
  await server.sessions.waitForIdle(session.id)
  assert.equal(server.sessions.faultCount(), 0)
  const messages = model.requests.at(-1)!.messages as { role: string; content: string }[]
  const result = JSON.parse(messages.filter(message => message.role === 'tool').at(-1)!.content)
  assert.equal(result[0].content, '临时测试角色偏好薄荷茶')
  assert.equal(result[0].scopeKey, '7')
})
