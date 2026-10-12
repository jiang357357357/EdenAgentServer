import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { napcatTools } from '../../../src/modules/mon/napcat-tools.ts'

const identity = { coreBaseUrl: 'https://core.example', userId: '77', secret: 'test-only-secret' }
const catalog = { protocol: 'napcat-action.v1', actions: {
  get_group_list: { description: '读取群列表', mutating: false, target: 'account', target_field: null,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  set_group_kick: { description: '移除群成员', mutating: true, target: 'group', target_field: 'group_id',
    parameters: { type: 'object', properties: { group_id: { type: 'integer' }, user_id: { type: 'integer' } },
      required: ['group_id', 'user_id'], additionalProperties: false } },
  _get_group_notice: { description: '读取群公告', mutating: false, target: 'group', target_field: 'group_id',
    parameters: { type: 'object', properties: { group_id: { type: 'integer' } }, required: ['group_id'], additionalProperties: false } },
} }
interface SentRequest { url: string; headers: Headers; body: Record<string, unknown> }
function fixture(qq = true, responder?: (call: SentRequest) => Response | Promise<Response>) {
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const session = repository.create('NapCat test', qq ? [{ assistantId: 1 }] : [],
    { botQq: '99999', contactQq: '88888' }, { purpose: 'user_chat', sourceChannel: qq ? 'qq' : 'app' })
  if (qq) database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)')
    .run('123456', '234567', session.id, Date.now())
  else database.transaction(() => new MonConnectionRepository(database).saveInTransaction(session.id,
    { coreBaseUrl: 'https://user-core.example', coreToken: 'test-only-token' }))
  const sent: SentRequest[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
    sent.push(call)
    return responder ? responder(call) : receipt(call, call.body.action === '__capabilities__' ? catalog : { accepted: true })
  }
  const permissions = new PermissionService(database, repository.events)
  const client = new NapcatClient(repository, identity, fetcher), turnId = randomUUID()
  const tools = napcatTools(client, permissions, session.id, turnId)
  const controller = new AbortController(), context = { signal: controller.signal, callId: 'test-call' }
  return { database, repository, session, permissions, client, sent, context, turnId,
    tool: (name: string) => tools.find(tool => tool.name === name)!,
    allow() { if (qq) permissions.setQqMode('123456', '234567', 'full_access'); else permissions.setMode('full_access') },
    close() { controller.abort(); database.close() } }
}
function receipt(call: SentRequest, result: unknown, status = 'success') {
  return Response.json({ success: status === 'success', data: { request_id: call.body.request_id, action: call.body.action,
    status, result, code: '', message: '' } }, { status: status === 'unknown' ? 202 : 200 })
}
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)) }

test('QQ catalog exposes full schema and signs persistent contact identity instead of mutable environment', async t => {
  const f = fixture(); t.after(() => f.close()); f.allow()
  const result = await f.tool('list_qq_capabilities').execute({ action: 'set_group_kick' }, f.context)
  assert.deepEqual((result as { result: unknown }).result, { protocol: catalog.protocol, actions: { set_group_kick: catalog.actions.set_group_kick } })
  const call = f.sent[0]!, h = call.headers
  assert.equal(call.url, 'https://core.example/api/devices/qq_bot/actions/execute/')
  assert.deepEqual(call.body.qq_context, { session_id: f.session.id, bot_qq: '123456', contact_qq: '234567' })
  assert.equal(h.get('Authorization'), null)
  assert.equal(h.get('X-Mon-Subject-User-ID'), '77')
  const digest = createHash('sha256').update(JSON.stringify(call.body)).digest('hex')
  const expected = createHmac('sha256', identity.secret).update(['monagent', 'self_awake:user_context',
    h.get('X-Mon-Service-Timestamp'), h.get('X-Mon-Service-Nonce'), '77', 'POST',
    '/api/devices/qq_bot/actions/execute/', digest].join('\n')).digest('hex')
  assert.equal(h.get('X-Mon-Service-Signature'), expected)
  assert.equal(f.permissions.list()[0]?.capability, 'qq.napcat.read')
})

test('overview without schemas and action-specific constraints survive capability discovery', async t => {
  const detail = { ...catalog.actions.set_group_kick, one_of_fields: ['user_id', 'member_id'],
    bridge_only_fields: ['sub_type'], available: false, unavailable_reason: '版本不支持', source: 'NapCat v4' }
  const f = fixture(true, call => {
    const full = Boolean((call.body.params as { action?: string }).action)
    return receipt(call, { protocol: catalog.protocol, count: 1, actions: { set_group_kick: full ? detail : {
      description: detail.description, mutating: true, target: 'group', available: false, unavailable_reason: detail.unavailable_reason,
    } } })
  })
  t.after(() => f.close()); f.allow()
  const overview = await f.tool('list_qq_capabilities').execute({}, f.context)
  assert.equal((overview as { result: { count: number } }).result.count, 1)
  const result = await f.tool('list_qq_capabilities').execute({ action: 'set_group_kick' }, f.context)
  assert.deepEqual((result as { result: { actions: unknown } }).result.actions, { set_group_kick: detail })
  await assert.rejects(f.tool('execute_qq_action').execute({ action: 'set_group_kick', params: {} }, f.context), /不可用/)
  assert.equal(f.sent.some(call => call.body.action === 'set_group_kick'), false)
})

test('model cannot override QQ identity, select another bot, call meta actions, or invent an allowlist action', async t => {
  const f = fixture(); t.after(() => f.close()); f.allow()
  for (const input of [{ bot_id: '1' }, { operator: '88888' }, { qq_context: { contact_qq: '88888' } }])
    await assert.rejects(f.tool('list_qq_capabilities').execute(input, f.context))
  await assert.rejects(f.tool('read_qq_action').execute({ action: '__events__', params: {} }, f.context))
  assert.equal(f.sent.length, 0)
  await assert.rejects(f.tool('read_qq_action').execute({ action: 'not_allowlisted', params: {} }, f.context), /允许列表/)
  assert.deepEqual(f.sent.map(call => call.body.action), ['__capabilities__'])
})

test('real restricted approval blocks all network requests; app full access does not authorize QQ', async t => {
  const f = fixture(); t.after(() => f.close())
  f.permissions.setMode('full_access')
  const waiting = f.tool('execute_qq_action').execute({ action: 'set_group_kick', params: { group_id: 100, user_id: 200 } }, f.context)
  const rejected = assert.rejects(waiting, /Permission denied/)
  await tick()
  assert.equal(f.sent.length, 0)
  const approval = f.permissions.list()[0]!
  assert.equal(approval.state, 'pending')
  assert.equal(approval.capability, 'qq.napcat.write')
  assert.deepEqual(approval.details, { action: 'set_group_kick', params: { group_id: 100, user_id: 200 }, channel: 'qq_action', bot: '123456' })
  assert.match(approval.resource, /123456:contact:234567:set_group_kick/)
  f.permissions.resolve(approval.id, false)
  await rejected
  assert.equal(f.sent.length, 0)
})

test('approval resumes only the reviewed write and fixes mode and request id outside model input', async t => {
  const f = fixture(); t.after(() => f.close())
  const waiting = f.tool('execute_qq_action').execute({ action: 'set_group_kick', params: { group_id: 100, user_id: 200 } }, f.context)
  await tick()
  f.permissions.resolve(f.permissions.list()[0]!.id, true)
  await waiting
  assert.deepEqual(f.sent.map(call => call.body.action), ['__capabilities__', 'set_group_kick'])
  const write = f.sent[1]!.body
  assert.equal(write.mode, 'write')
  assert.equal(write.request_id, `${f.turnId}:test-call`)
  assert.deepEqual(write.params, { group_id: 100, user_id: 200 })
})

test('read and write action tools cannot cross mutating classification', async t => {
  const f = fixture(); t.after(() => f.close()); f.allow()
  await assert.rejects(f.tool('read_qq_action').execute({ action: 'set_group_kick', params: {} }, f.context), /读写类型/)
  await assert.rejects(f.tool('execute_qq_action').execute({ action: 'get_group_list', params: {} }, f.context), /读写类型/)
  assert.deepEqual(f.sent.map(call => call.body.action), ['__capabilities__', '__capabilities__'])
})

test('leading-underscore NapCat actions are discoverable and executable through the allowlist', async t => {
  const f = fixture(); t.after(() => f.close()); f.allow()
  await f.tool('read_qq_action').execute({ action: '_get_group_notice', params: { group_id: 100 } }, f.context)
  assert.deepEqual(f.sent[0]!.body.params, { action: '_get_group_notice' })
  assert.equal(f.sent[1]!.body.action, '_get_group_notice')
})

test('Core superadmin rejection prevents the real action despite local full access', async t => {
  const f = fixture(true, () => Response.json({ success: false, error: '需要此机器人的个人超级管理员权限' }, { status: 403 }))
  t.after(() => f.close()); f.allow()
  const result = await f.tool('execute_qq_action').execute({ action: 'set_group_kick', params: { group_id: 100, user_id: 200 } }, f.context)
  assert.equal((result as { status: string }).status, 'failed')
  assert.equal((result as { code: string }).code, 'HTTP_403')
  assert.match((result as { message: string }).message, /个人超级管理员/)
  assert.deepEqual(f.sent.map(call => call.body.action), ['__capabilities__'])
})

test('events expose returned request flags through approved filters', async t => {
  const items = [{ event: { post_type: 'request', request_type: 'group', flag: 'known-flag', sub_type: 'add' } }]
  const f = fixture(true, call => receipt(call, { items, next_cursor: null, retention_seconds: 86400, max_events: 500 }))
  t.after(() => f.close()); f.allow()
  const previous = f.client.modelReceipt(f.client.target(f.session.id), { request_id: 'cursor-fixture', action: '__events__',
    status: 'success', result: { next_cursor: 'earlier' } }) as { model_view: { result: { next_cursor: string } } }
  const result = await f.tool('list_qq_events').execute({ event_type: 'request', limit: 20, cursor: previous.model_view.result.next_cursor }, f.context)
  assert.deepEqual(f.sent[0]!.body.params, { type: 'request', limit: 20, cursor: 'earlier' })
  assert.deepEqual((result as { result: { items: unknown } }).result.items, items)
})

test('lost or mismatched write receipt stays unknown and sends only once', async t => {
  for (const mismatch of [false, true]) {
    const f = fixture(true, call => {
      if (call.body.action === '__capabilities__') return receipt(call, catalog)
      if (mismatch) return receipt({ ...call, body: { ...call.body, request_id: 'another-request' } }, {})
      throw new Error('connection lost after send')
    })
    t.after(() => f.close()); f.allow()
    const result = await f.tool('execute_qq_action').execute({ action: 'set_group_kick', params: { group_id: 100, user_id: 200 } }, f.context)
    assert.equal((result as { status: string }).status, 'unknown')
    assert.equal(f.sent.filter(call => call.body.action === 'set_group_kick').length, 1)
  }
})

test('App calls use only session Core credentials and explicit bot database ID', async t => {
  const f = fixture(false); t.after(() => f.close()); f.allow()
  await f.tool('read_qq_action').execute({ bot_id: '42', action: 'get_group_list', params: {} }, f.context)
  const call = f.sent[1]!
  assert.equal(call.url, 'https://user-core.example/api/devices/qq_bot/42/actions/execute/')
  assert.equal(call.headers.get('Authorization'), 'Token test-only-token')
  assert.equal(call.headers.get('X-Mon-Service-ID'), null)
  assert.equal(call.body.qq_context, undefined)
  assert.equal(call.body.mode, 'read')
})

test('missing persistent QQ mapping fails closed and cancellation before approval sends nothing', async t => {
  const f = fixture(); t.after(() => f.close())
  const waiting = f.tool('list_qq_events').execute({}, f.context)
  const rejected = assert.rejects(waiting, /cancelled/)
  await tick()
  f.permissions.resolve(f.permissions.list()[0]!.id, false, 'cancelled')
  await rejected
  assert.equal(f.sent.length, 0)
  f.database.connection.prepare('DELETE FROM qq_channel_conversations WHERE session_id=?').run(f.session.id)
  await assert.rejects(f.tool('list_qq_events').execute({}, f.context))
  assert.equal(f.sent.length, 0)
})
