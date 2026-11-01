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
import { setImmediate } from 'node:timers/promises'

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
  permissions.setQqMode('111111', '222222', 'full_access', '333333')
  const client = new NapcatClient(repository, identity, fetcher)
  const tools = napcatTools(client, permissions, session.id, randomUUID())
  const context = { callId: 'group-call', signal: new AbortController().signal }
  return { database, repository, session, sent, client, permissions, context,
    tool: (name: string) => tools.find(tool => tool.name === name)!, close: () => database.close() }
}

test('group tools use the private QQ catalog and keep the signed source identity', async t => {
  const f = groupFixture(); t.after(f.close)
  const listed = await f.tool('list_qq_capabilities').execute({}, f.context)
  assert.deepEqual(Object.keys((listed as { result: { actions: object } }).result.actions), Object.keys(actions))
  await f.tool('read_qq_action').execute({ action: 'get_group_info', params: { group_id: '333333' } }, f.context)
  const sent = f.sent.at(-1)!
  assert.deepEqual(sent.params, { group_id: '333333' })
  assert.deepEqual(sent.qq_context, { session_id: f.session.id, bot_qq: '111111', group_qq: '333333', contact_qq: '222222' })
  assert.equal(f.permissions.list().at(-1)?.capability, 'qq.napcat.read')
  assert.equal(f.permissions.list().at(-1)?.state, 'allowed')
  await f.tool('read_qq_action').execute({ action: 'get_group_info', params: { group_id: '444444' } }, f.context)
  assert.deepEqual(f.sent.at(-1)?.params, { group_id: '444444' })
  await f.tool('list_qq_events').execute({}, f.context)
  await f.tool('read_qq_action').execute({ action: 'get_login_info', params: {} }, f.context)
})

test('group modification uses the shared permission mode rather than legacy allow_actions', async t => {
  const f = groupFixture(); t.after(f.close)
  await f.tool('execute_qq_action').execute({ action: 'set_group_name', params: { group_name: 'new' } }, f.context)
  assert.equal(f.sent.at(-1)?.mode, 'write')
  assert.equal(f.permissions.list()[0]?.capability, 'qq.napcat.write')
  await f.tool('execute_qq_action').execute({ action: 'send_private_msg', params: { user_id: '222222' } }, f.context)
  assert.equal(f.sent.filter(item => item.action === 'send_private_msg').length, 1)
})

test('group permission is isolated from app/private takeover and supports pending approvals', async t => {
  const f = groupFixture(); t.after(f.close)
  f.permissions.setMode('takeover')
  f.permissions.setQqMode('111111', '222222', 'takeover')
  f.permissions.setQqMode('111111', '222222', 'restricted', '333333')
  const controller = new AbortController()
  const pending = f.permissions.request({ ...f.context, signal: controller.signal, sessionId: f.session.id, turnId: randomUUID() },
    'workspace.read', 'owner-files', {})
  await setImmediate()
  assert.equal(f.permissions.list()[0]?.state, 'pending')
  const cancelled = assert.rejects(pending, /cancelled/)
  controller.abort(); await cancelled
  assert.equal(f.permissions.list().some(item => item.state === 'pending'), false)
  assert.equal(new MemoryScopes(f.database).optionalCurrent(f.session.id, randomUUID()), undefined)
})

for (const mode of ['restricted', 'full_access', 'takeover'] as const) {
  test(`private and group ${mode} use the same terminal approval behavior`, async t => {
    const f = groupFixture(); t.after(f.close)
    const privateSession = f.repository.create('Private', [{ assistantId: 1, characterId: 2 }], null,
      { purpose: 'user_chat', sourceChannel: 'qq' })
    f.database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)')
      .run('111111', '222222', privateSession.id, Date.now())
    f.permissions.setQqMode('111111', '222222', mode)
    f.permissions.setQqMode('111111', '222222', mode, '333333')
    for (const sessionId of [privateSession.id, f.session.id]) {
      let executed = false
      const task = f.permissions.request({ ...f.context, sessionId, turnId: randomUUID() },
        'command.execute', 'fixture-terminal', {}).then(() => { executed = true })
      await setImmediate()
      if (mode === 'takeover') assert.equal(executed, true)
      else {
        assert.equal(executed, false)
        const request = f.permissions.list(sessionId).find(item => item.state === 'pending')!
        assert.ok(request); f.permissions.resolve(request.id, true)
      }
      await task; assert.equal(executed, true)
    }
  })
}

test('group bridge keeps input ownership while returning the shared progress stream', async t => {
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
  const accepted = await bridge.submit({ ...base, schema_version: 'qq-group-turn.v3', message_id: 'msg-1', text: '群问题', assistant_id: 1, character_id: 2 }) as { input_id: string; turn_id: string }
  const start = sessions.start as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.match(String(start.mock.calls[0]!.arguments[2]), /qq-group:111111:333333:222222:msg-1/)
  f.database.connection.prepare("UPDATE inputs SET state='completed' WHERE id=?").run(accepted.input_id)
  f.repository.events.append(f.session.id, accepted.turn_id, 'permission.requested', { resource: 'private-secret' })
  f.repository.events.append(f.session.id, accepted.turn_id, 'qq.file_requested', { filename: 'private-file' })
  f.repository.events.append(f.session.id, accepted.turn_id, 'agent.message_end', { message: { role: 'assistant', content: 'public reply' } })
  f.repository.events.append(f.session.id, accepted.turn_id, 'agent.message_end', {
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'private-tool-detail' }] },
  })
  const status = bridge.status({ ...base, input_id: accepted.input_id }) as { status: string; text: string; updates: { kind: string }[] }
  assert.equal(status.status, 'completed'); assert.equal(status.text, 'public reply')
  assert.equal(status.updates.some(update => update.kind === 'file_send'), true)
  f.database.connection.prepare("UPDATE inputs SET state='interrupted' WHERE id=?").run(accepted.input_id)
  assert.equal((bridge.status({ ...base, input_id: accepted.input_id }) as { status: string }).status, 'interrupted')
  assert.throws(() => bridge.status({ ...base, contact_qq: '999999', input_id: accepted.input_id }), /not found/)
  assert.throws(() => bridge.submit({ ...base, user_id: '8', schema_version: 'qq-group-turn.v1', message_id: 'msg-2', text: 'x', assistant_id: 1, character_id: 2 }), /owner mismatch/)
})
