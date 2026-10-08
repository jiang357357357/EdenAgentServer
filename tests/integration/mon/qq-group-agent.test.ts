import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { napcatTools } from '../../../src/modules/mon/napcat-tools.ts'
import { QqGroupBridge } from '../../../src/modules/qq-channel/group-bridge.ts'
import { MemoryScopes } from '../../../src/modules/memories/scope.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'

const identity = { coreBaseUrl: 'https://core.example', userId: '7', secret: 'test-group-secret' }
const metadata = (target: string, mutating: boolean) => ({ description: 'test', target, mutating,
  parameters: { type: 'object', properties: { group_id: { type: 'string' } }, additionalProperties: false } })
const actions = { get_group_info: metadata('group', false), set_group_name: metadata('group', true),
  get_login_info: metadata('account', false), send_private_msg: metadata('user', true) }

function groupFixture() {
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const sent: Record<string, unknown>[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    sent.push(body)
    return Response.json({ data: { request_id: body.request_id, action: body.action, status: 'success', code: '', message: '',
      result: body.action === '__capabilities__' ? { protocol: 'napcat-action.v1', actions } : { group_name: '本群' } } })
  }
  const session = repository.create('Group', [{ assistantId: 1, characterId: 2 }],
    { channelAudience: 'qq_group', groupQq: '333333' }, { purpose: 'user_chat', sourceChannel: 'qq' })
  repository.ownership.assign(session.id, accountKey(identity.coreBaseUrl, identity.userId))
  database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)')
    .run(session.id, '111111', '333333', '222222', 0, Date.now())
  const permissions = new PermissionService(database, repository.events)
  const client = new NapcatClient(repository, identity, fetcher)
  const tools = napcatTools(client, permissions, session.id, randomUUID())
  const context = { callId: 'group-call', signal: new AbortController().signal }
  return { database, repository, session, sent, client, permissions, context,
    tool: (name: string) => tools.find(tool => tool.name === name)!, close: () => database.close() }
}

test('group tools sign the actual speaker, inject only the current group and exclude account/private abilities', async t => {
  const f = groupFixture(); t.after(f.close)
  const listed = await f.tool('list_qq_capabilities').execute({}, f.context)
  assert.deepEqual(Object.keys((listed as { result: { actions: object } }).result.actions), ['get_group_info'])
  await f.tool('read_qq_action').execute({ action: 'get_group_info', params: {} }, f.context)
  const sent = f.sent.at(-1)!
  assert.deepEqual(sent.params, { group_id: '333333' })
  assert.deepEqual(sent.qq_context, { session_id: f.session.id, bot_qq: '111111', group_qq: '333333', contact_qq: '222222' })
  assert.equal(f.permissions.list().at(-1)?.capability, 'qq.napcat.group.read')
  assert.equal(f.permissions.list().at(-1)?.state, 'allowed')
  const count = f.sent.length
  await assert.rejects(f.tool('read_qq_action').execute({ action: 'get_group_info', params: { group_id: '444444' } }, f.context), /当前群/)
  await assert.rejects(f.tool('list_qq_events').execute({}, f.context), /整个机器人/)
  await assert.rejects(f.tool('execute_qq_action').execute({ action: 'set_group_name', params: { group_name: 'new' } }, f.context), /未明确启用/)
  assert.equal(f.sent.length, count)
  await assert.rejects(f.tool('read_qq_action').execute({ action: 'get_login_info', params: {} }, f.context), /允许列表/)
})

test('group modification requires persisted explicit opt-in and cannot target a private recipient', async t => {
  const f = groupFixture(); t.after(f.close)
  f.database.connection.prepare('UPDATE qq_group_sessions SET allow_actions=1 WHERE session_id=?').run(f.session.id)
  await f.tool('execute_qq_action').execute({ action: 'set_group_name', params: { group_name: 'new' } }, f.context)
  assert.equal(f.sent.at(-1)?.mode, 'write')
  assert.equal(f.permissions.list()[0]?.capability, 'qq.napcat.group.write')
  await assert.rejects(f.tool('execute_qq_action').execute({ action: 'send_private_msg', params: { user_id: '222222' } }, f.context), /允许列表/)
  assert.equal(f.sent.filter(item => item.action === 'send_private_msg').length, 0)
})

test('group permission cannot inherit app or private takeover and never waits for public approval', async t => {
  const f = groupFixture(); t.after(f.close)
  f.permissions.setMode('takeover')
  f.permissions.setQqMode('111111', '222222', 'takeover')
  await assert.rejects(f.permissions.request({ ...f.context, sessionId: f.session.id, turnId: randomUUID() },
    'workspace.read', 'owner-files', {}), /Permission unavailable/)
  assert.equal(f.permissions.list()[0]?.state, 'denied')
  assert.equal(f.permissions.list().some(item => item.state === 'pending'), false)
  assert.equal(new MemoryScopes(f.database).optionalCurrent(f.session.id, randomUUID()), undefined)
})

test('group bridge keeps private and other-operator sessions isolated and status omits sensitive events', async t => {
  const f = groupFixture(); t.after(f.close)
  const privateSession = f.repository.create('Private', [{ assistantId: 1, characterId: 2 }], null,
    { purpose: 'user_chat', sourceChannel: 'qq' })
  f.database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)')
    .run('111111', '222222', privateSession.id, Date.now())
  const sessions = new SessionService(f.repository, undefined)
  t.after(() => sessions.close())
  const inputs = new InputRepository(f.database, f.repository.events)
  t.mock.method(sessions, 'start', (sessionId: string, text: string, key?: string) => {
    assert.equal(sessionId, f.session.id)
    return inputs.enqueue(sessionId, text, key!)
  })
  const mon = { catalog: async () => { throw new Error('unexpected fresh binding') } } as unknown as MonBindingService
  const bridge = new QqGroupBridge(identity, f.database, sessions, mon, f.context.signal)
  const base = { user_id: '7', bot_qq: '111111', group_qq: '333333', contact_qq: '222222' }
  const accepted = await bridge.submit({ ...base, schema_version: 'qq-group-turn.v1', message_id: 'msg-1', text: '群问题', assistant_id: 1, character_id: 2 }) as { input_id: string; turn_id: string }
  const start = sessions.start as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.match(String(start.mock.calls[0]!.arguments[2]), /qq-group:111111:333333:222222:msg-1/)
  f.database.connection.prepare("UPDATE inputs SET state='completed' WHERE id=?").run(accepted.input_id)
  f.repository.events.append(f.session.id, accepted.turn_id, 'permission.requested', { resource: 'private-secret' })
  f.repository.events.append(f.session.id, accepted.turn_id, 'qq.file_requested', { filename: 'private-file' })
  f.repository.events.append(f.session.id, accepted.turn_id, 'agent.message_end', { message: { role: 'assistant', content: 'public reply' } })
  f.repository.events.append(f.session.id, accepted.turn_id, 'agent.message_end', {
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'private-tool-detail' }] },
  })
  const status = bridge.status({ ...base, input_id: accepted.input_id })
  assert.deepEqual(status, { status: 'completed', text: 'public reply', updates: [], next_seq: '0', has_more: false })
  f.database.connection.prepare("UPDATE inputs SET state='interrupted' WHERE id=?").run(accepted.input_id)
  assert.deepEqual(bridge.status({ ...base, input_id: accepted.input_id }),
    { status: 'interrupted', updates: [], next_seq: '0', has_more: false })
  assert.throws(() => bridge.status({ ...base, contact_qq: '999999', input_id: accepted.input_id }), /not found/)
  assert.throws(() => bridge.submit({ ...base, user_id: '8', schema_version: 'qq-group-turn.v1', message_id: 'msg-2', text: 'x', assistant_id: 1, character_id: 2 }), /owner mismatch/)
})
