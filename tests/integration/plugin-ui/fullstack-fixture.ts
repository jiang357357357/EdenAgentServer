import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginUiCall } from '@eden/api'
import type { RuntimeScope } from '../../../src/bootstrap/runtime-scope.ts'

export const todoPluginId = 'fullstack-todos'
export const todoRuntimeId = 'fullstack-todos:backend'
export async function writeTodoPackage(directory: string, dataRoot: string, version = 1) {
  await mkdir(path.join(directory, 'skills/todos'), { recursive: true })
  const files = {
    'plugin.json': JSON.stringify({ schemaVersion: 1, id: todoPluginId, name: '持久化待办', description: '前端、MCP 后端和 SQLite 组合插件', version: `${version}.0.0`,
      components: { ui: [{ id: 'ui', entry: 'ui.json', enabledByDefault: true }],
        runtimes: [{ id: 'backend', kind: 'mcp_stdio', manifest: 'runtime.json', enabledByDefault: true }],
        skills: [{ id: 'todo-guide', path: 'skills/todos', enabledByDefault: true }] },
      permissions: [{ capability: 'process.execute', resource: 'node', access: 'execute', required: true, description: '运行本插件的待办后端' }] }),
    'ui.json': JSON.stringify({ schemaVersion: 1, type: 'module', apiVersion: 1, entry: 'client.mjs',
      views: [{ id: 'todos', title: '持久化待办', slot: 'sidebar_panel' }], capabilities: { sessionRead: false, sessionSend: false, tools: ['call_mcp_tool'] } }),
    'runtime.json': JSON.stringify({ schemaVersion: 1, command: 'node', args: ['/package/backend.mjs', dataRoot, String(version)], cwd: '.' }),
    'backend.mjs': await readFile(new URL('./fixtures/todo-backend.mjs', import.meta.url), 'utf8'),
    'client.mjs': (await readFile(new URL('./fixtures/todo-client.mjs', import.meta.url), 'utf8')).replaceAll('__TODO_VERSION__', String(version)),
    'skills/todos/SKILL.md': '---\nname: fullstack-todos\ndescription: 通过持久化待办后端管理任务\nmetadata:\n  edenagent:\n    tools: [call_mcp_tool]\n    profiles: [user_chat]\n---\n使用待办工具读取和修改任务，以实际返回的数据为准。',
  }
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content)
  return files
}
export async function installTodoPackage(runtime: RuntimeScope, directory: string, grant = true) {
  const { pluginMarket } = runtime.services
  const preview = await pluginMarket.inspectLocal(directory)
  pluginMarket.installed.install(pluginMarket.previews.read(preview.previewID), true, false)
  if (grant) pluginMarket.installed.setPermissions(todoPluginId, preview.revision,
    [{ capability: 'process.execute', resource: 'node', access: 'execute', decision: 'allowed' }])
  if (grant) pluginMarket.installed.enable(todoPluginId)
  return preview
}
export async function waitUntil(predicate: () => unknown | Promise<unknown>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Fullstack plugin condition timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
export function todoCall(runtime: RuntimeScope, sessionId: string, action: string, input: Record<string, unknown> = {}, requestId = randomUUID()) {
  const module = runtime.services.pluginUi.list().modules.find(item => item.pluginId === todoPluginId)!
  if (!module) throw new Error('Todo UI module is unavailable')
  const request: PluginUiCall = { pluginId: module.pluginId, componentId: module.componentId, revision: module.revision,
    viewId: 'todos', sessionId, action: 'tool.call', requestId,
    input: { name: 'call_mcp_tool', input: { runtimeId: todoRuntimeId, name: 'todos', arguments: { action, ...input } } } as PluginUiCall['input'] }
  return runtime.services.pluginUi.call(request)
}
export function todoValue(value: Awaited<ReturnType<typeof todoCall>>) {
  return (value as { structuredContent: { version: number; pid: number; schemaVersion: number;
    todos: { id: number; title: string; done: boolean; priority?: number }[] } }).structuredContent
}
