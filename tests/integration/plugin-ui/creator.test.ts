import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { recordedModel } from '@eden/runtime-pi/testing'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { uiPluginGuide } from '../../../src/model-prompts/ui-plugins.ts'
import { UI_PLUGIN_SKILL_GUIDE } from '../../../src/model-prompts/ui-plugin-skill.ts'

test('the real model discovers and reads the UI skill before authoring, inspecting and activating its package', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-ui-creator-'))
  let model: Awaited<ReturnType<typeof recordedModel>> | undefined
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
  t.after(async () => {
    try { await runtime?.close() } finally { await model?.close(); await rm(root, { recursive: true, force: true }) }
  })
  const workspace = path.join(root, 'workspace'), directory = path.join(workspace, 'widget')
  await mkdir(directory, { recursive: true })
  const files = uiPluginGuide().files
  model = await recordedModel([
    { tool: 'list_skills', input: {} },
    { tool: 'load_skill', input: { name: 'eden-ui-development' } },
    { tool: 'manage_ui_plugins', input: { action: 'describe' } },
    ...Object.entries(files).map(([name, content]) => ({ tool: 'write_file', input: { path: `widget/${name}`, content } })),
    { tool: 'manage_ui_plugins', input: { action: 'inspect', path: directory } },
    { tool: 'manage_ui_plugins', input: { action: 'install', id: 'my-widget' } },
    { tool: 'manage_ui_plugins', input: { action: 'list' } },
    { text: '已经安装会话工具面板' },
  ])
  // This fixed authoring transcript has no compaction reply. Keep it within a
  // realistic large context; compaction behavior has its own recorded fixtures.
  runtime = await openRuntime({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(root, 'data') }, root), model: { ...model.config, contextWindow: 128000 } })
  const services = runtime.services
  services.permissions.setMode('full_access')
  const session = services.repository.create('智能体创建界面', [], null)
  services.workspace.forSession(session.id).switch(workspace)
  services.sessions.start(session.id, '创建并安装一个读取当前会话标题的侧边面板')
  await services.sessions.waitForIdle(session.id)
  if (model.requests.length !== 10) t.diagnostic(JSON.stringify({
    operations: runtime.database.connection.prepare('SELECT tool_name,state FROM tool_operations WHERE session_id=? ORDER BY rowid').all(session.id),
    failures: runtime.database.connection.prepare("SELECT kind,payload_json FROM events WHERE session_id=? AND (kind LIKE '%fail%' OR kind LIKE '%compact%')").all(session.id),
  }))
  assert.equal(model.requests.length, 10)
  assert.match(JSON.stringify(model.requests[0]!.messages), /eden-ui-development/)
  const heading = UI_PLUGIN_SKILL_GUIDE.content.split('\n')[0]!
  assert.equal(JSON.stringify(model.requests[0]!.messages).includes(heading), false)
  assert.equal(JSON.stringify(model.requests[2]!.messages).includes(heading), true)
  const modules = services.pluginUi.list().modules
  assert.equal(modules.length, 1)
  assert.equal(modules[0]!.pluginId, 'my-widget')
  assert.equal(modules[0]!.document.views[0]!.slot, 'sidebar_panel')
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(directory, name), 'utf8'), content)
  const operations = runtime.database.connection.prepare('SELECT tool_name,state FROM tool_operations WHERE session_id=? ORDER BY rowid').all(session.id)
  assert.deepEqual(operations.map(item => item.tool_name), ['list_skills', 'load_skill', 'manage_ui_plugins', 'write_file', 'write_file', 'write_file',
    'manage_ui_plugins', 'manage_ui_plugins', 'manage_ui_plugins'])
  assert.ok(operations.every(item => item.state === 'completed'))
})
