import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'
import { cuaToolNames } from '@eden/api'

test('real host uses a reduced default catalog while retaining deferred capabilities for discovery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-capability-host-'))
  const model = await recordedModel([{ tool: 'list_tools', input: { query: 'manage_plugins' } }, { text: '找到插件开发能力' }])
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  t.after(async () => {
    try { await server?.close() }
    finally { await model.close(); await rm(root, { recursive: true, force: true }) }
  })
  server = await startServer({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config })
  await server.memoryExtractions.close()
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
  assert.ok(exposed.includes('desktop_list_windows'))
  for (const name of cuaToolNames) {
    assert.equal(all.find(tool => tool.name === `cua_${name}`)?.exposure, 'deferred')
    assert.ok(!exposed.includes(`cua_${name}`))
  }
  for (const name of ['desktop_observe', 'desktop_read_text', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_drag', 'desktop_window', 'desktop_launch']) {
    assert.equal(all.find(tool => tool.name === name)?.exposure, 'deferred')
    assert.ok(!exposed.includes(name))
  }
  assert.ok(!exposed.includes('manage_plugins'))
  assert.ok(!exposed.includes('dispatch_due_memos'))
  assert.ok(exposed.length < all.length / 2)
  t.diagnostic(`Registered tools: ${all.length}; default model tools: ${exposed.length}`)
  assert.match(JSON.stringify(model.requests[1]!.messages), /builtin:manage_plugins/)
})

test('real host executes an unshown builtin before loading and after unloading with one durable operation per call', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-direct-tool-host-'))
  const model = await recordedModel([
    { tool: 'list_mcp_servers', input: {} },
    { tool: 'load_tools', input: { tools: [{ id: 'builtin:list_mcp_servers' }] } },
    { tool: 'list_mcp_servers', input: {} },
    { tool: 'unload_tools', input: { ids: ['builtin:list_mcp_servers'] } },
    { tool: 'list_mcp_servers', input: {} }, { text: '完成' },
  ])
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  t.after(async () => {
    try { await server?.close() }
    finally { await model.close(); await rm(root, { recursive: true, force: true }) }
  })
  server = await startServer({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config })
  await server.memoryExtractions.close()
  const session = server.sessions.repository.create('直接调用已知工具')
  server.sessions.start(session.id, '直接调用当前已注册的 MCP 服务列表工具。')
  await server.sessions.waitForIdle(session.id)
  const visible = model.requests.map(request => ((request.tools ?? []) as { function: { name: string } }[]).some(tool => tool.function.name === 'list_mcp_servers'))
  assert.deepEqual(visible, [false, false, true, true, false, false])
  const operations = server.sessions.repository.database.connection.prepare('SELECT tool_name,state FROM tool_operations WHERE session_id=? ORDER BY rowid').all(session.id)
  assert.deepEqual(operations.map(row => row.tool_name), ['list_mcp_servers', 'load_tools', 'list_mcp_servers', 'unload_tools', 'list_mcp_servers'])
  assert.ok(operations.every(row => row.state === 'completed'))
  t.diagnostic(JSON.stringify({ schemaVisible: visible, durableOperations: operations }))
})
