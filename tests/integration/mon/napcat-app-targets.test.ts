import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { napcatTools } from '../../../src/modules/mon/napcat-tools.ts'

const bot = (id: string | number = '42', fields = {}) => ({ id, bot_id: '123456', bot_name: '我的机器人',
  qq_nickname: '', status: 'online', is_default: true, ...fields })
const actions = { get_group_list: { description: '读取群列表', mutating: false, target: 'account',
  parameters: { type: 'object', properties: {}, additionalProperties: false } },
  send_private_msg: { description: '发私聊消息', mutating: true, target: 'user',
    parameters: { type: 'object', properties: { user_id: { type: 'integer' }, message: { type: 'string' } } } } }
interface Call { url: string; method: string; headers: Headers; body: Record<string, unknown> }
function fixture(records: unknown[] = [bot()]) {
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const session = repository.create('App', [], {}, { purpose: 'user_chat', sourceChannel: 'app' })
  const connections = new MonConnectionRepository(database)
  const connection = { coreBaseUrl: 'https://account-a.example', coreToken: 'account-a-fixture' }
  database.transaction(() => connections.saveInTransaction(session.id, connection))
  const calls: Call[] = [], controller = new AbortController()
  const state = { records, request: async (call: Call): Promise<Response> => call.method === 'GET'
    ? Response.json({ success: true, data: state.records })
    : Response.json({ success: true, data: { status: 'success', request_id: call.body.request_id,
      action: call.body.action, result: call.body.action === '__capabilities__'
        ? { protocol: 'napcat-action.v1', actions } : { accepted: true }, message: '', code: '' } }) }
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} }
    calls.push(call); return state.request(call)
  }
  const client = new NapcatClient(repository, { coreBaseUrl: 'https://service.example', userId: '99', secret: 'not-an-app-credential' }, fetcher)
  const permissions = new PermissionService(database, repository.events), turnId = randomUUID()
  const tools = napcatTools(client, permissions, session.id, turnId)
  return { database, repository, session, calls, client, connections, state, permissions, controller,
    context: { callId: 'test-call', signal: controller.signal },
    tool: (name: string) => tools.find(tool => tool.name === name)!,
    connect(value = connection) { database.transaction(() => connections.saveInTransaction(session.id, value)) },
    close() { controller.abort(); database.close() } }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('empty App capability call discovers a unique bot using its Core record ID, not its QQ account', async t => {
  const f = fixture(); t.after(() => f.close()); f.permissions.setMode('full_access')
  const result = await f.tool('list_qq_capabilities').execute({}, f.context) as { status: string; bot_id: string; result: { actions: unknown } }
  assert.equal(result.status, 'success'); assert.equal(result.bot_id, '42'); assert.deepEqual(result.result.actions, actions)
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [
    ['GET', 'https://account-a.example/api/devices/qq_bot/?summary=true'],
    ['POST', 'https://account-a.example/api/devices/qq_bot/42/actions/execute/'],
  ])
  for (const call of f.calls) {
    assert.equal(call.headers.get('Authorization'), 'Token account-a-fixture')
    assert.equal(call.headers.get('X-Mon-Service-ID'), null); assert.equal(call.body.qq_context, undefined)
  }
  assert.equal(f.permissions.list().at(-1)!.resource, 'qq-bot:42')
  assert.equal((f.permissions.list().at(-1)!.details as { bot: string }).bot, '42')
})

test('all four tools resolve an omitted bot ID, including action schema, events and write approval', async t => {
  const cases = [
    ['list_qq_capabilities', { action: 'get_group_list' }, '__capabilities__'],
    ['list_qq_events', { event_type: 'request', limit: 5 }, '__events__'],
    ['read_qq_action', { action: 'get_group_list', params: {} }, 'get_group_list'],
    ['execute_qq_action', { action: 'send_private_msg', params: { user_id: 77777, message: 'fixture' } }, 'send_private_msg'],
  ] as const
  for (const [name, input, action] of cases) {
    const f = fixture([bot(42)]); t.after(() => f.close()); f.permissions.setMode('full_access')
    const result = await f.tool(name).execute(input, f.context) as { status: string; bot_id: string }
    assert.equal(result.status, 'success'); assert.equal(result.bot_id, '42')
    assert.equal(f.calls.filter(call => call.body.action === action).length, 1)
    assert.equal((f.permissions.list().at(-1)!.details as { bot: string }).bot, '42')
    assert.ok(f.calls.filter(call => call.method === 'POST').every(call => call.url.includes('/qq_bot/42/')))
  }
})

test('multiple bots return a sanitized choice list for every tool and never execute a default or first bot', async t => {
  const records = [bot('42', { qq_contacts: [{ user_id: 'secret-contact' }], device_credential: 'private' }),
    bot('43', { bot_id: '987654', bot_name: '第二个机器人', is_default: false })]
  for (const [name, input] of [['list_qq_capabilities', {}], ['list_qq_events', {}],
    ['read_qq_action', { action: 'get_group_list', params: {} }],
    ['execute_qq_action', { action: 'send_private_msg', params: { user_id: 77777, message: 'fixture' } }]] as const) {
    const f = fixture(records); t.after(() => f.close()); f.permissions.setMode('full_access')
    const result = await f.tool(name).execute(input, f.context) as { status: string; selection_required: boolean; bots: unknown[] }
    assert.equal(result.status, 'selection_required'); assert.equal(result.selection_required, true)
    assert.deepEqual(result.bots, [{ bot_id: '42', bot_qq: '123456', name: '我的机器人', status: 'online', is_default: true },
      { bot_id: '43', bot_qq: '987654', name: '第二个机器人', status: 'online', is_default: false }])
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.method, 'GET')
    assert.ok(!JSON.stringify(result).includes('secret-contact')); assert.ok(!JSON.stringify(result).includes('private'))
    await f.tool('list_qq_capabilities').execute({ bot_id: '43' }, f.context)
    assert.equal(f.calls.at(-1)!.url, 'https://account-a.example/api/devices/qq_bot/43/actions/execute/')
  }
})

test('no configured bot is an actionable result, while authentication failures and malformed lists stay failures', async t => {
  const f = fixture([]); t.after(() => f.close()); f.permissions.setMode('full_access')
  const result = await f.tool('list_qq_capabilities').execute({}, f.context) as { status: string; bots: unknown[] }
  assert.equal(result.status, 'not_configured'); assert.deepEqual(result.bots, []); assert.equal(f.calls.length, 1)
  for (const status of [401, 403, 500]) {
    f.state.request = async () => Response.json({ error: 'fixture failure' }, { status })
    await assert.rejects(f.tool('list_qq_capabilities').execute({}, f.context), new RegExp(String(status)))
  }
  for (const data of [null, [bot('0')], [bot(9007199254740992)], [bot('42'), bot('42')]]) {
    f.state.request = async () => Response.json({ success: true, data })
    await assert.rejects(f.tool('list_qq_capabilities').execute({}, f.context))
  }
  assert.equal(f.calls.some(call => call.method === 'POST'), false)
})

test('discovery is approved before any network access, and actual bot permission is checked separately', async t => {
  const f = fixture(); t.after(() => f.close())
  let promise = f.tool('list_qq_capabilities').execute({}, f.context)
  let rejected = assert.rejects(promise, /Permission denied/)
  await tick(); assert.equal(f.calls.length, 0)
  f.permissions.resolve(f.permissions.list().find(item => item.state === 'pending')!.id, false)
  await rejected
  promise = f.tool('execute_qq_action').execute({ action: 'send_private_msg', params: { user_id: 77777, message: 'fixture' } }, f.context)
  rejected = assert.rejects(promise, /Permission denied/)
  await tick(); f.permissions.resolve(f.permissions.list().find(item => item.state === 'pending')!.id, true)
  await tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.method, 'GET')
  const approval = f.permissions.list().find(item => item.state === 'pending')!
  assert.equal(approval.capability, 'qq.napcat.write'); assert.equal(approval.resource, 'qq-bot:42:send_private_msg')
  assert.equal((approval.details as { bot: string }).bot, '42')
  f.permissions.resolve(approval.id, false); await rejected
  assert.equal(f.calls.length, 1)
})

test('a stale discovery result is discarded after changing Core credentials or closing the session', async t => {
  for (const operation of ['token', 'url', 'close'] as const) {
    const f = fixture(); t.after(() => f.close()); f.permissions.setMode('full_access')
    let finish!: (value: Response) => void
    f.state.request = () => new Promise(resolve => { finish = resolve })
    const promise = f.tool('list_qq_capabilities').execute({}, f.context)
    const rejected = assert.rejects(promise, /已变更|active session/)
    await tick()
    if (operation === 'close') f.repository.setStatus(f.session.id, 'closed')
    else f.connect({ coreBaseUrl: operation === 'url' ? 'https://account-b.example' : 'https://account-a.example', coreToken: 'account-b-fixture' })
    finish(Response.json({ success: true, data: [bot()] })); await rejected
    assert.equal(f.calls.length, 1)
  }
})

test('account changes while approving a resolved write prevent sending to the old account', async t => {
  const f = fixture(); t.after(() => f.close())
  const promise = f.tool('execute_qq_action').execute({ action: 'send_private_msg', params: { user_id: 77777, message: 'fixture' } }, f.context)
  const rejected = assert.rejects(promise, /已变更/)
  await tick(); f.permissions.resolve(f.permissions.list().find(item => item.state === 'pending')!.id, true)
  await tick(); f.connect({ coreBaseUrl: 'https://account-b.example', coreToken: 'account-b-fixture' })
  f.permissions.resolve(f.permissions.list().find(item => item.state === 'pending')!.id, true)
  await rejected; assert.equal(f.calls.length, 1)
})

test('connection changes during action schema lookup cannot turn into a stale write', async t => {
  const f = fixture(); t.after(() => f.close()); f.permissions.setMode('full_access')
  const original = f.state.request
  f.state.request = async call => {
    const response = await original(call)
    if (call.body.action === '__capabilities__') f.connect({ coreBaseUrl: 'https://account-b.example', coreToken: 'account-b-fixture' })
    return response
  }
  await assert.rejects(f.tool('execute_qq_action').execute({ action: 'send_private_msg', params: { user_id: 77777, message: 'fixture' } }, f.context), /已变更/)
  assert.equal(f.calls.filter(call => call.body.action === 'send_private_msg').length, 0)
})

test('cancellation during discovery and missing Core connections never fall back to service credentials', async t => {
  const f = fixture(); t.after(() => f.close()); f.permissions.setMode('full_access')
  f.state.request = async () => { f.controller.abort(new Error('fixture cancelled')); return Response.json({ success: true, data: [bot()] }) }
  await assert.rejects(f.tool('list_qq_capabilities').execute({}, f.context), /fixture cancelled/)
  assert.equal(f.calls.length, 1)
  const empty = fixture(); t.after(() => empty.close()); empty.permissions.setMode('full_access')
  empty.database.connection.prepare('DELETE FROM mon_connections WHERE session_id=?').run(empty.session.id)
  await assert.rejects(empty.tool('list_qq_capabilities').execute({}, empty.context), /尚未连接 Core/)
  assert.equal(empty.calls.length, 0)
})
