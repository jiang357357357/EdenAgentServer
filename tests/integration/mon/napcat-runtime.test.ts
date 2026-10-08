import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { createServices } from '../../../src/bootstrap/services.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { napcatPermissionPreview } from '../../../src/modules/qq-channel/napcat-preview.ts'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import { createServer } from 'node:http'

test('real Mon runtime registers and exposes all four NapCat tools to a QQ model turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-napcat-runtime-'))
  const model = await recordedModel([{ text: '能力已就绪' }])
  const database = new EdenDatabase(':memory:', 'mon')
  const services = createServices(database, { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root }, root), origin: 'mon' })
  t.after(async () => {
    await services.memoryExtractions.close()
    await Promise.all([services.sessions.close(), services.mon.close(), services.plugins.close(), services.companion.close()])
    services.questions.close(); database.close()
    await model.close(); await rm(root, { recursive: true, force: true })
  })
  t.mock.method(services.models, 'resolve', () => model.config)
  const expected = ['list_qq_capabilities', 'list_qq_events', 'read_qq_action', 'execute_qq_action']
  const all = services.sessions.toolCatalog()
  for (const name of expected) assert.ok(all.some(tool => tool.name === name), name)
  const session = services.repository.create('QQ tools', [{ assistantId: 1 }], null,
    { purpose: 'user_chat', sourceChannel: 'qq' })
  services.repository.ownership.assign(session.id, accountKey('https://test-core.example', '77'))
  services.sessions.start(session.id, '检查可用工具')
  await services.sessions.waitForIdle(session.id)
  assert.equal(services.sessions.faultCount(), 0)
  assert.ok(model.requests.length > 0)
  const exposed = (model.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  for (const name of expected) assert.ok(exposed.includes(name), name)
  assert.ok(!exposed.includes('send_qq_message'), 'owner-target legacy sender stays outside QQ allowlist')
})

test('real group runtime exposes only scoped QQ tools and excludes private memory and host tools', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-qq-group-runtime-'))
  const model = await recordedModel([{ text: '这是群内回答' }])
  const database = new EdenDatabase(':memory:', 'mon')
  const services = createServices(database, { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root }, root), origin: 'mon' })
  t.after(async () => {
    await services.memoryExtractions.close()
    await Promise.all([services.sessions.close(), services.mon.close(), services.plugins.close(), services.companion.close()])
    services.questions.close(); database.close(); await model.close(); await rm(root, { recursive: true, force: true })
  })
  t.mock.method(services.models, 'resolve', () => model.config)
  const search = t.mock.method(services.memories, 'search', () => { throw new Error('private memory must not be queried') })
  const session = services.repository.create('QQ group', [{ assistantId: 1, characterId: 2 }], { channelAudience: 'qq_group' },
    { purpose: 'user_chat', sourceChannel: 'qq' })
  services.repository.ownership.assign(session.id, accountKey('https://test-core.example', '77'))
  database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)').run(session.id, '111111', '333333', '222222', 0, Date.now())
  services.sessions.start(session.id, '群内问题')
  await services.sessions.waitForIdle(session.id)
  assert.equal(services.sessions.faultCount(), 0)
  const exposed = (model.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  assert.deepEqual(exposed.sort(), ['execute_qq_action', 'list_qq_capabilities', 'read_qq_action'])
  assert.equal(search.mock.calls.length, 0)
  assert.match(JSON.stringify(model.requests[0]!.messages), /多人可见的 QQ 群聊/)
})

test('QQ approval preserves bot and target IDs before truncating long operation content', () => {
  const preview = napcatPermissionPreview({ channel: 'qq_action', bot: '123456', action: 'set_group_kick', params: {
    content: '正文'.repeat(1000), group_id: '987654321', user_id: '234567890', message_id: '1122334455', tid: 'full-qzone-tid',
  } })!
  assert.match(preview, /机器人: 123456/)
  for (const id of ['987654321', '234567890', '1122334455', 'full-qzone-tid']) assert.ok(preview.includes(id))
  assert.ok(preview.indexOf('group_id=') < preview.indexOf('正文'))
  assert.ok(preview.length < 800)
})

test('signed group bridge creates a fresh bound runtime and separates operators in the same group', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-qq-group-bridge-'))
  const model = await recordedModel([{ text: '第一位成员的回答' }, { text: '第二位成员的回答' }])
  const core = createServer((request, response) => {
    const url = request.url ?? ''
    const entity = { id: 1, ai_model: 'group-test-model', ai_name: 'Group model', vendor: 'recorded', status: 'active',
      api_key: 'test-model-key', api_endpoint: model.config.baseUrl, default_params: { context_window: 32000, max_tokens: 1024 } }
    const body = url === '/api/internal/service-token/' ? { user_id: '7', token: 'test-core-token' } :
      url.startsWith('/api/assistants/') ? { id: 1, name: '群角色', character: { id: 2, name: '群角色', ai_talk_entity_id: 1 } } :
      url === '/api/agent/settings/my/' ? { default_model: '1' } : url === '/api/core/vendors/ai/' ? { vendors: {} } :
        url === '/api/ai/entities/' ? [entity] : entity
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve))
  const address = core.address(); assert.ok(address && typeof address !== 'string')
  const database = new EdenDatabase(':memory:', 'mon')
  const identity = { coreBaseUrl: `http://127.0.0.1:${address.port}`, userId: '7', secret: 'test-group-secret' }
  const services = createServices(database, { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root }, root), origin: 'mon', monIdentity: identity })
  t.after(async () => {
    await services.qqChannelBridge!.close(); await services.memoryExtractions.close()
    await Promise.all([services.sessions.close(), services.mon.close(), services.plugins.close(), services.companion.close()])
    services.questions.close(); database.close(); await model.close()
    core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  const ids: string[] = []
  for (const contact of ['222222', '444444']) {
    const common = { user_id: '7', bot_qq: '111111', group_qq: '333333', contact_qq: contact }
    const accepted = await services.qqChannelBridge!.submit({ ...common, schema_version: 'qq-group-turn.v1',
      message_id: `message-${contact}`, text: '本群的问题', assistant_id: 1, character_id: 2, allow_actions: false }) as { session_id: string; input_id: string }
    ids.push(accepted.session_id)
    await services.sessions.waitForIdle(accepted.session_id)
    assert.equal(services.sessions.faultCount(), 0)
    const status = services.qqChannelBridge!.status({ ...common, input_id: accepted.input_id }) as { status: string; text: string; updates: unknown[] }
    assert.equal(status.status, 'completed')
    assert.ok(status.text.includes('成员的回答'))
    assert.deepEqual(status.updates, [])
  }
  assert.notEqual(ids[0], ids[1])
  assert.equal(database.connection.prepare('SELECT count(*) AS n FROM qq_channel_conversations').get()?.n, 0)
  assert.equal(database.connection.prepare('SELECT count(*) AS n FROM qq_group_sessions').get()?.n, 2)
})
