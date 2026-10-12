import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { qqResultFixture, rawTid, rawMessageId } from './qq-result-fixture.ts'

test('qzone receipts keep raw audit values, give the model a business reference and resolve deletion under the original approval', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const tool = f.tool('execute_qq_action')
  const raw = await tool.execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  const view = tool.modelResult!(raw) as { result: { tid: string } }
  assert.match(JSON.stringify(raw), new RegExp(rawTid)); assert.doesNotMatch(JSON.stringify(view), new RegExp(rawTid))
  assert.doesNotMatch(JSON.stringify(view), /request_id|requestId/)
  assert.match(view.result.tid, /^qqref:qzone:/)
  await tool.execute({ bot_id: '42', action: 'delete_qzone_msg', params: { tid: view.result.tid } }, { ...f.context, callId: 'delete' })
  assert.equal(f.sent.at(-1)!.params.tid, rawTid)
  const approval = f.permissions.list().find(item => item.resource.endsWith(':delete_qzone_msg'))!
  assert.equal((approval.details as { params: { tid: string } }).params.tid, rawTid)
})

test('message, request and cursor references remain usable and action schemas advertise references', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const target = f.client.target(f.session.id, '42')
  const receipt = f.client.modelReceipt(target, { request_id: 'fixture', action: 'send_private_msg', status: 'success',
    result: { message_id: rawMessageId } }) as { model_view: { result: { message_id: string } } }
  await f.tool('read_qq_action').execute({ bot_id: '42', action: 'get_msg', params: { message_id: receipt.model_view.result.message_id } }, f.context)
  assert.equal(f.sent.at(-1)!.params.message_id, rawMessageId)
  const events = await f.tool('list_qq_events').execute({ bot_id: '42' }, f.context)
  const view = f.tool('list_qq_events').modelResult!(events) as { result: { items: { event: { flag: string } }[]; next_cursor: string } }
  assert.doesNotMatch(JSON.stringify(view), /native-request-flag|native-next-cursor/)
  await f.tool('list_qq_events').execute({ bot_id: '42', cursor: view.result.next_cursor }, f.context)
  assert.equal(f.sent.at(-1)!.params.cursor, 'native-next-cursor')
  await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'set_group_add_request',
    params: { flag: view.result.items[0]!.event.flag, sub_type: 'add' } }, f.context)
  assert.equal(f.sent.at(-1)!.params.flag, 'native-request-flag')
  const detail = await f.tool('list_qq_capabilities').execute({ bot_id: '42', action: 'delete_qzone_msg' }, f.context)
  const schema = JSON.stringify(f.tool('list_qq_capabilities').modelResult!(detail))
  assert.match(schema, /qqref/); assert.match(schema, /业务引用/)
})

test('references reject raw IDs, wrong types, other bots and other sessions before sending an action', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const result = await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  const ref = (f.tool('execute_qq_action').modelResult!(result) as { result: { tid: string } }).result.tid
  f.sent.length = 0
  for (const input of [{ bot_id: '42', action: 'delete_qzone_msg', params: { tid: rawTid } },
    { bot_id: '43', action: 'delete_qzone_msg', params: { tid: ref } },
    { bot_id: '42', action: 'delete_msg', params: { message_id: ref } }])
    await assert.rejects(f.tool('execute_qq_action').execute(input, f.context), /业务引用/)
  const other = f.sessions.create('other')
  f.database.transaction(() => new MonConnectionRepository(f.database).saveInTransaction(other.id,
    { coreBaseUrl: 'https://core.example', coreToken: 'test-only-token' }))
  assert.throws(() => f.client.resolveParams(f.client.target(other.id, '42'), { tid: ref }), /业务引用/)
  assert.equal(f.sent.length, 0)
})

test('failed and unknown receipts preserve their status and hide previously known platform IDs echoed in error prose', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const raw = await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  f.tool('execute_qq_action').modelResult!(raw)
  for (const status of ['failed', 'unknown'] as const) {
    const receipt = f.client.modelReceipt(f.client.target(f.session.id, '42'), { request_id: 'internal-trace', action: 'delete_qzone_msg', status,
      code: 'UPSTREAM_ERROR', message: `could not confirm ${rawTid}`, result: { confirmed: false } })
    const view = f.tool('execute_qq_action').modelResult!(receipt) as { status: string; result: { confirmed: boolean } }
    assert.equal(view.status, status); assert.equal(view.result.confirmed, false)
    assert.doesNotMatch(JSON.stringify(view), new RegExp(`${rawTid}|internal-trace`))
  }
  assert.equal(f.sent.filter(item => item.action === 'send_qzone_msg').length, 1)
})

test('reference mappings survive reopening a temporary database and credential scope changes reject them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-qq-references-'))
  let reopened: EdenDatabase | undefined
  t.after(async () => {
    reopened?.close()
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'eden-qq-references-')))
    await rm(root, { recursive: true, force: true })
  })
  const filename = path.join(root, 'test.sqlite'), f = qqResultFixture(filename)
  const result = await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  const ref = (f.tool('execute_qq_action').modelResult!(result) as { result: { tid: string } }).result.tid
  const id = f.session.id; f.close()
  const database = new EdenDatabase(filename, 'mon'), sessions = new SessionRepository(database, 'mon')
  reopened = database
  const client = new NapcatClient(sessions)
  assert.equal(client.resolveParams(client.target(id, '42'), { tid: ref }).tid, rawTid)
  database.transaction(() => new MonConnectionRepository(database).saveInTransaction(id,
    { coreBaseUrl: 'https://other-account.example', coreToken: 'other-token' }))
  assert.throws(() => client.resolveParams(client.target(id, '42'), { tid: ref }), /业务引用/)
})

test('reference persistence failure is marked fatal after a single completed platform write', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  f.database.connection.exec("CREATE TRIGGER reject_qq_reference BEFORE INSERT ON qq_action_references BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  const raw = await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  assert.throws(() => f.tool('execute_qq_action').modelResult!(raw),
    (error: unknown) => error instanceof Error && error.name === 'RuntimePersistenceError')
  assert.equal(f.sent.filter(item => item.action === 'send_qzone_msg').length, 1)
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM qq_action_references').get()?.n, 0)
})
