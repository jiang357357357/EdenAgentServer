import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { recordedModel } from '@eden/runtime-pi/testing'
import { toJson } from '@eden/api'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { uiPluginGuide } from '../../../src/model-prompts/ui-plugins.ts'
import { uiPluginTools } from '../../../src/modules/plugin-ui/index.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { setTimeout as delay } from 'node:timers/promises'

async function fixture(t: TestContext, replies: Parameters<typeof recordedModel>[0] = [{ text: 'UI message received' }]) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-ui-'))
  let model: Awaited<ReturnType<typeof recordedModel>> | undefined
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
  t.after(async () => {
    try { await runtime?.close() } finally { await model?.close(); await rm(root, { recursive: true, force: true }) }
  })
  model = await recordedModel(replies)
  runtime = await openRuntime({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(root, 'data') }, root), model: model.config })
  const services = runtime.services
  services.permissions.setMode('full_access')
  const session = services.repository.create('我的工作会话', [], null)
  const directory = path.join(root, 'widget')
  await mkdir(directory)
  const files = uiPluginGuide().files
  const document = { ...JSON.parse(files['ui.json']), capabilities: { sessionRead: true, sessionSend: true, tools: ['read_file', 'create_reminder', 'list_memos_page'] } }
  for (const [name, content] of Object.entries({ ...files, 'ui.json': JSON.stringify(document) })) await writeFile(path.join(directory, name), content)
  const tool = uiPluginTools(services.pluginMarket, services.permissions, session.id, randomUUID())[0]!
  const context = { callId: randomUUID(), signal: new AbortController().signal }
  await tool.execute({ action: 'inspect', path: directory }, context)
  await tool.execute({ action: 'install', id: 'my-widget' }, context)
  const module = services.pluginUi.list().modules[0]!
  const call = (action: 'session.read' | 'session.send' | 'tool.call', input: Record<string, unknown> = {}, requestId = randomUUID()) =>
    services.pluginUi.call({ pluginId: module.pluginId, componentId: module.componentId, revision: module.revision,
      viewId: 'main', sessionId: session.id, action, input: toJson(input) as Record<string, never>, requestId })
  return { root, runtime, services, session, directory, module, call, model }
}

test('Creator inspection/install exposes the exact frozen module; disable, component toggle and version selection withdraw it', async t => {
  const f = await fixture(t)
  assert.equal(f.module.document.views[0]!.slot, 'sidebar_panel')
  assert.match(f.services.pluginUi.read(f.module).source, /export function activate/)
  assert.equal((await f.call('session.read') as { title: string }).title, '我的工作会话')
  f.services.pluginUi.report({ pluginId: f.module.pluginId, componentId: f.module.componentId, revision: f.module.revision,
    clientId: randomUUID(), viewId: 'main', status: 'mounted' })
  assert.equal(f.services.pluginUi.status()[0]!.status, 'mounted')
  assert.deepEqual(withAccount({ key: 'another-account', userId: '2', coreBaseUrl: 'https://fixture.invalid' }, () => f.services.pluginUi.status()), [])
  f.services.pluginMarket.installed.setComponent('my-widget', f.module.revision, 'main', false)
  assert.equal(f.services.pluginUi.list().modules.length, 0)
  assert.equal(f.services.pluginUi.status().length, 0)
  await assert.rejects(async () => f.call('session.read'), /unavailable/)
  f.services.pluginMarket.installed.setComponent('my-widget', f.module.revision, 'main', true)
  assert.equal(f.services.pluginUi.list().modules.length, 1)
  f.services.pluginMarket.installed.disable('my-widget')
  assert.equal(f.services.pluginUi.list().modules.length, 0)
  f.services.pluginMarket.installed.enable('my-widget')
  await writeFile(path.join(f.directory, 'client.js'), uiPluginGuide().files['client.js'].replace('读取会话', '新版会话'))
  const preview = await f.services.pluginMarket.inspectLocal(f.directory)
  f.services.pluginMarket.installed.install(f.services.pluginMarket.previews.read(preview.previewID), true, false)
  f.services.pluginMarket.installed.enable('my-widget')
  assert.notEqual(f.services.pluginUi.list().modules[0]!.revision, f.module.revision)
  assert.throws(() => f.services.pluginUi.read(f.module), /active version changed/)
})

test('UI actions use real workspace tools, permissions and idempotent normal session admission', async t => {
  const f = await fixture(t)
  const workspace = path.join(f.root, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'note.txt'), 'UI_WORKSPACE_VALUE')
  f.services.workspace.forSession(f.session.id).switch(workspace)
  assert.match(JSON.stringify(await f.call('tool.call', { name: 'read_file', input: { path: 'note.txt' } })), /UI_WORKSPACE_VALUE/)
  assert.ok(f.services.permissions.list(f.session.id).some(item => item.capability === 'plugin.ui.tool'))
  await assert.rejects(async () => f.call('tool.call', { name: 'exec_command', input: { command: 'echo forbidden' } }), /not declared/)
  const missingId = randomUUID()
  await assert.rejects(f.call('tool.call', { name: 'read_file', input: { path: 'missing.txt' } }, missingId))
  await assert.rejects(async () => f.call('tool.call', { name: 'read_file', input: { path: 'missing.txt' } }, missingId), /已经执行|尚未确认/)
  const requestId = randomUUID()
  const first = await f.call('session.send', { text: '从扩展发送的真实消息' }, requestId)
  assert.deepEqual(await f.call('session.send', { text: '从扩展发送的真实消息' }, requestId), first)
  await assert.rejects(async () => f.call('session.send', { text: '不同的消息' }, requestId), /identity was reused/)
  await f.services.sessions.waitForIdle(f.session.id)
  assert.equal(f.model.requests.length, 1)
  assert.match(JSON.stringify(f.model.requests[0]!.messages), /从扩展发送的真实消息/)
})

test('revoking a component while approval is pending prevents execution; cancellation settles the request', async t => {
  const f = await fixture(t)
  const workspace = path.join(f.root, 'workspace')
  await mkdir(workspace)
  f.services.workspace.forSession(f.session.id).switch(workspace)
  f.services.permissions.setMode('restricted')
  const requested = new Promise<string>(resolve => {
    const stop = f.services.repository.events.subscribe(event => {
      if (event.kind === 'permission.requested') { stop(); resolve(String((event.payload as { id: string }).id)) }
    })
  })
  const result = f.call('tool.call', { name: 'read_file', input: { path: 'missing.txt' } })
  const rejected = assert.rejects(result, /disabled|unavailable/)
  const permissionId = await requested
  f.services.pluginMarket.installed.disable('my-widget')
  f.services.permissions.resolve(permissionId, true)
  await rejected
  f.services.pluginMarket.installed.enable('my-widget')
  const id = randomUUID(), pending = f.call('tool.call', { name: 'read_file', input: { path: 'missing.txt' } }, id)
  const cancelled = assert.rejects(pending, /cancel/i)
  assert.equal(f.services.pluginUi.cancel(id).cancelled, true)
  await cancelled
})

test('UI calls reject undeclared views, background sessions, disabled packages and another account', async t => {
  const f = await fixture(t)
  const input = { pluginId: f.module.pluginId, componentId: f.module.componentId, revision: f.module.revision,
    viewId: 'main', sessionId: f.session.id, action: 'session.read' as const, input: {}, requestId: randomUUID() }
  await assert.rejects(async () => f.services.pluginUi.call({ ...input, viewId: 'unknown' }), /not declared/)
  const background = f.services.repository.create('Background', [], null, { purpose: 'subagent', sourceChannel: 'internal' })
  await assert.rejects(async () => f.services.pluginUi.call({ ...input, sessionId: background.id }), /application conversation/)
  const foreign = { key: 'another-account', userId: '2', coreBaseUrl: 'https://fixture.invalid' }
  await assert.rejects(async () => withAccount(foreign, () => f.services.pluginUi.call(input)), /account|owned|unavailable|not found|账号/i)
})

test('a user message queues behind a pending UI tool action instead of running concurrently', async t => {
  const f = await fixture(t)
  const workspace = path.join(f.root, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'note.txt'), 'RESERVED_WORKSPACE')
  f.services.workspace.forSession(f.session.id).switch(workspace)
  f.services.permissions.setMode('restricted')
  const requested = new Promise<string>(resolve => {
    const stop = f.services.repository.events.subscribe(event => {
      if (event.kind === 'permission.requested') { stop(); resolve(String((event.payload as { id: string }).id)) }
    })
  })
  const action = f.call('tool.call', { name: 'read_file', input: { path: 'note.txt' } })
  const permissionId = await requested
  assert.equal(f.services.sessions.isRunning(f.session.id), true)
  f.services.sessions.start(f.session.id, '界面操作结束后再执行这条消息')
  await delay(30)
  assert.equal(f.model.requests.length, 0)
  f.services.permissions.resolve(permissionId, true)
  assert.match(JSON.stringify(await action), /RESERVED_WORKSPACE/)
  await f.services.sessions.waitForIdle(f.session.id)
  assert.equal(f.model.requests.length, 1)
})

async function runningModel(t: TestContext) {
  const f = await fixture(t, [{ wait: true }, { text: 'Next queued message' }])
  f.services.sessions.start(f.session.id, 'Keep this response active')
  for (let i = 0; i < 500 && !f.model.requests.length; i++) await delay(10)
  assert.equal(f.model.requests.length, 1)
  return f
}

test('tools wait behind a live model response, then execute once in FIFO order without blocking session reads or sends', async t => {
  const f = await runningModel(t)
  const id = randomUUID(), input = (title: string) => ({ name: 'create_reminder', input: { title, remindAt: Date.now() + 86400000 } })
  const first = f.call('tool.call', input('first queued reminder'), id)
  const second = f.call('tool.call', input('second queued reminder'))
  await delay(25)
  assert.equal(f.services.pluginUi.operation({ ...f.module, viewId: 'main', sessionId: f.session.id, requestId: id }).state, 'waiting')
  assert.equal(f.services.repository.database.connection.prepare('SELECT COUNT(*) AS count FROM memos').get()!.count, 0)
  assert.equal((await f.call('session.read') as { executionStatus: string }).executionStatus, 'busy')
  await f.call('session.send', { text: 'A user message can still be admitted' })
  f.model.releaseWaiting()
  const result = await first
  await second
  await f.services.sessions.waitForIdle(f.session.id)
  assert.equal((result as { delivery: { channel: string } }).delivery.channel, 'auto')
  assert.deepEqual(f.services.repository.database.connection.prepare('SELECT title FROM memos ORDER BY id').all().map(row => row.title),
    ['first queued reminder', 'second queued reminder'])
  assert.equal(f.model.requests.length, 2)
})

test('cancelling a waiting UI operation never performs its write after the response becomes idle', async t => {
  const f = await runningModel(t), id = randomUUID()
  const pending = f.call('tool.call', { name: 'create_reminder', input: { title: 'cancelled before execution', remindAt: Date.now() + 86400000 } }, id)
  const rejected = assert.rejects(pending, /cancel/i)
  await delay(20)
  assert.equal(f.services.pluginUi.cancel(id).cancelled, true)
  await rejected
  f.model.releaseWaiting(); await f.services.sessions.waitForIdle(f.session.id)
  assert.equal(f.services.repository.database.connection.prepare('SELECT COUNT(*) AS count FROM memos').get()!.count, 0)
})

test('queued operations revalidate a disabled component before requesting approval or writing', async t => {
  const f = await runningModel(t)
  const pending = f.call('tool.call', { name: 'create_reminder', input: { title: 'revoked while queued', remindAt: Date.now() + 86400000 } })
  const rejected = assert.rejects(pending, /disabled|unavailable/)
  await delay(20)
  f.services.pluginMarket.installed.disable('my-widget')
  f.model.releaseWaiting()
  await rejected; await f.services.sessions.waitForIdle(f.session.id)
  assert.equal(f.services.repository.database.connection.prepare('SELECT COUNT(*) AS count FROM memos').get()!.count, 0)
})

test('stopping a conversation also cancels its waiting user operations', async t => {
  const f = await runningModel(t)
  const pending = f.call('tool.call', { name: 'create_reminder', input: { title: 'stop cancels this', remindAt: Date.now() + 86400000 } })
  const rejected = assert.rejects(pending, /cancel/i)
  await delay(20)
  await f.services.sessions.cancel(f.session.id)
  await rejected; await f.services.sessions.waitForIdle(f.session.id)
  assert.equal(f.services.repository.database.connection.prepare('SELECT COUNT(*) AS count FROM memos').get()!.count, 0)
})
