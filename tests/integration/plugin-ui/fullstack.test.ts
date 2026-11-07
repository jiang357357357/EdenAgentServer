import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { installTodoPackage, todoCall, todoPluginId, todoRuntimeId, todoValue, waitUntil, writeTodoPackage } from './fullstack-fixture.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-plugin-fullstack-'))
  const config = loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(root, 'host') }, root)
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
  t.after(async () => { try { await runtime?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const open = async () => {
    runtime = await openRuntime(config)
    runtime.services.permissions.setMode('full_access')
    runtime.services.mcp.start()
    return runtime
  }
  await open()
  const session = runtime!.services.repository.create('完整插件测试', [], null)
  const directory = path.join(root, 'package'), data = path.join(root, 'plugin-data')
  await writeTodoPackage(directory, data)
  const ready = () => waitUntil(() => runtime!.services.mcp.list().runtimes.some(item => item.id === todoRuntimeId))
  return { root, directory, data, session, get runtime() { return runtime! }, open, ready,
    async restart() { await runtime!.close(); await open(); await ready() } }
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

test('a combined UI/MCP/skill package requires a grant, persists CRUD across restart and migration, and preserves data on uninstall', { timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const preview = await installTodoPackage(f.runtime, f.directory, false)
  assert.throws(() => f.runtime.services.pluginMarket.installed.enable(todoPluginId), /permission/i)
  assert.equal(f.runtime.services.mcp.list().runtimes.length, 0)
  assert.equal(f.runtime.services.pluginUi.list().modules.length, 0)
  f.runtime.services.pluginMarket.installed.setPermissions(todoPluginId, preview.revision,
    [{ capability: 'process.execute', resource: 'node', access: 'execute', decision: 'allowed' }])
  f.runtime.services.pluginMarket.installed.enable(todoPluginId)
  await f.ready()
  assert.equal(f.runtime.services.skills.repository.read('fullstack-todos').enabled, true)
  const first = todoValue(await todoCall(f.runtime, f.session.id, 'add', { title: '重启后仍存在' }))
  const second = todoValue(await todoCall(f.runtime, f.session.id, 'add', { title: '随后删除' }))
  assert.equal(second.todos.length, 2)
  const done = todoValue(await todoCall(f.runtime, f.session.id, 'update', { id: first.todos[0]!.id, done: true }))
  assert.equal(done.todos[0]!.done, true)
  await todoCall(f.runtime, f.session.id, 'delete', { id: second.todos[1]!.id })
  await f.restart()
  assert.equal(alive(first.pid), false)
  const restored = todoValue(await todoCall(f.runtime, f.session.id, 'list'))
  assert.equal(restored.todos.length, 1)
  assert.equal(restored.todos[0]!.title, '重启后仍存在')
  assert.equal(restored.todos[0]!.done, true)
  await writeTodoPackage(f.directory, f.data, 2)
  const upgraded = await installTodoPackage(f.runtime, f.directory, false)
  assert.throws(() => f.runtime.services.pluginMarket.installed.enable(todoPluginId), /permission/i)
  f.runtime.services.pluginMarket.installed.setPermissions(todoPluginId, upgraded.revision,
    [{ capability: 'process.execute', resource: 'node', access: 'execute', decision: 'allowed' }])
  f.runtime.services.pluginMarket.installed.enable(todoPluginId)
  await waitUntil(() => f.runtime.services.mcp.list().runtimes.some(item => item.revision === upgraded.revision))
  const v2 = todoValue(await todoCall(f.runtime, f.session.id, 'list'))
  assert.equal(v2.schemaVersion, 2)
  assert.equal(v2.todos[0]!.priority, 0)
  assert.equal(v2.todos[0]!.title, '重启后仍存在')
  const changed = todoValue(await todoCall(f.runtime, f.session.id, 'update', { id: v2.todos[0]!.id, priority: 7 }))
  assert.equal(changed.todos[0]!.priority, 7)
  f.runtime.services.pluginMarket.installed.remove(todoPluginId)
  await waitUntil(() => f.runtime.services.mcp.list().runtimes.length === 0)
  assert.equal(alive(v2.pid), false)
  assert.equal(f.runtime.services.pluginUi.list().modules.length, 0)
  assert.equal(f.runtime.services.skills.repository.list(false).some(item => item.name === 'fullstack-todos'), false)
  const persisted = new DatabaseSync(path.join(f.data, 'todos.db'), { readOnly: true })
  try { assert.equal(persisted.prepare('SELECT priority FROM todos').get()!.priority, 7) } finally { persisted.close() }
})

test('backend business failure remains a failure in MCP and UI action audit', { timeout: 40_000 }, async t => {
  const f = await fixture(t)
  await installTodoPackage(f.runtime, f.directory); await f.ready()
  const requestId = randomUUID()
  const result = await todoCall(f.runtime, f.session.id, 'fail', {}, requestId) as { isError: boolean }
  assert.equal(result.isError, true)
  const operation = f.runtime.database.connection.prepare('SELECT state FROM mcp_operations ORDER BY rowid DESC LIMIT 1').get()
  assert.equal(operation!.state, 'failed')
  const audit = f.runtime.database.connection.prepare("SELECT payload_json FROM events WHERE kind='plugin.ui.action.finished' ORDER BY rowid DESC LIMIT 1").get()
  assert.equal(JSON.parse(String(audit!.payload_json)).outcome, 'failed')
})

test('component stop and grant revocation withdraw backend access without removing persistent data', { timeout: 60_000 }, async t => {
  const f = await fixture(t)
  const preview = await installTodoPackage(f.runtime, f.directory); await f.ready()
  const value = todoValue(await todoCall(f.runtime, f.session.id, 'add', { title: '授权撤销保留数据' }))
  f.runtime.services.pluginMarket.installed.setComponent(todoPluginId, preview.revision, 'backend', false)
  await waitUntil(() => f.runtime.services.mcp.list().runtimes.length === 0)
  assert.equal(alive(value.pid), false)
  await assert.rejects(async () => todoCall(f.runtime, f.session.id, 'list'), /unavailable|excluded|不存在|not available/i)
  f.runtime.services.pluginMarket.installed.setComponent(todoPluginId, preview.revision, 'backend', true)
  await f.ready()
  assert.equal(todoValue(await todoCall(f.runtime, f.session.id, 'list')).todos.length, 1)
  f.runtime.services.pluginMarket.installed.setPermissions(todoPluginId, preview.revision,
    [{ capability: 'process.execute', resource: 'node', access: 'execute', decision: 'denied' }])
  await waitUntil(() => f.runtime.services.mcp.list().runtimes.length === 0)
  assert.equal(f.runtime.services.pluginUi.list().modules.length, 0)
})

test('a backend crash after commit is unknown and the same UI request cannot replay its side effect after host restart', { timeout: 60_000 }, async t => {
  const f = await fixture(t)
  await installTodoPackage(f.runtime, f.directory); await f.ready()
  const requestId = randomUUID()
  await assert.rejects(todoCall(f.runtime, f.session.id, 'crash_after_add', { title: '仅写入一次' }, requestId))
  const operation = f.runtime.database.connection.prepare('SELECT state FROM mcp_operations ORDER BY rowid DESC LIMIT 1').get()
  assert.equal(operation!.state, 'unknown')
  const audit = f.runtime.database.connection.prepare("SELECT payload_json FROM events WHERE kind='plugin.ui.action.finished' ORDER BY rowid DESC LIMIT 1").get()
  assert.equal(JSON.parse(String(audit!.payload_json)).outcome, 'unknown')
  await f.restart()
  await assert.rejects(async () => todoCall(f.runtime, f.session.id, 'crash_after_add', { title: '仅写入一次' }, requestId), /已经执行|尚未确认/)
  const value = todoValue(await todoCall(f.runtime, f.session.id, 'list'))
  assert.equal(value.todos.filter(item => item.title === '仅写入一次').length, 1)
})
