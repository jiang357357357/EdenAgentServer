import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { QqReferenceRepository } from '../../../src/modules/mon/qq-reference-repository.ts'
import { qqResultFixture, rawTid, rawMessageId, actionCatalog } from './qq-result-fixture.ts'

test('qzone receipts retain business IDs and deletion approval uses the same provider value', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const tool = f.tool('execute_qq_action')
  const raw = await tool.execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  const view = tool.modelResult!(raw) as { result: { tid: string } }
  assert.equal(view.result.tid, rawTid); assert.doesNotMatch(JSON.stringify(view), /request_id|requestId/)
  await tool.execute({ bot_id: '42', action: 'delete_qzone_msg', params: { tid: view.result.tid } }, { ...f.context, callId: 'delete' })
  assert.equal(f.sent.at(-1)!.params.tid, rawTid)
  const approval = f.permissions.list().find(item => item.resource.endsWith(':delete_qzone_msg'))!
  assert.equal((approval.details as { params: { tid: string } }).params.tid, rawTid)
})

test('message IDs, request flags, cursors and provider parameter schemas retain their original types', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  await f.tool('read_qq_action').execute({ bot_id: '42', action: 'get_msg', params: { message_id: rawMessageId } }, f.context)
  assert.equal(f.sent.at(-1)!.params.message_id, rawMessageId)
  const events = await f.tool('list_qq_events').execute({ bot_id: '42' }, f.context)
  const view = f.tool('list_qq_events').modelResult!(events) as { result: { items: { event: { flag: string } }[]; next_cursor: string } }
  assert.equal(view.result.next_cursor, 'native-next-cursor')
  assert.equal(view.result.items[0]!.event.flag, 'native-request-flag')
  await f.tool('list_qq_events').execute({ bot_id: '42', cursor: view.result.next_cursor }, f.context)
  assert.equal(f.sent.at(-1)!.params.cursor, 'native-next-cursor')
  await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'set_group_add_request',
    params: { flag: view.result.items[0]!.event.flag, sub_type: 'add' } }, f.context)
  assert.equal(f.sent.at(-1)!.params.flag, 'native-request-flag')
  const detail = await f.tool('list_qq_capabilities').execute({ bot_id: '42', action: 'delete_qzone_msg' }, f.context)
  const schema = f.tool('list_qq_capabilities').modelResult!(detail) as { result: typeof actionCatalog }
  assert.deepEqual(schema.result.actions.delete_qzone_msg, actionCatalog.actions.delete_qzone_msg)
})

test('legacy references still enforce type, account, bot and session scope before an action', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  const repository = new QqReferenceRepository(f.sessions)
  const ref = repository.remember(f.client.target(f.session.id, '42'), 'qzone', rawTid)
  assert.equal(f.client.resolveParams(f.client.target(f.session.id, '42'), { tid: ref }).tid, rawTid)
  for (const input of [{ bot_id: '43', action: 'delete_qzone_msg', params: { tid: ref } },
    { bot_id: '42', action: 'delete_msg', params: { message_id: ref } }])
    await assert.rejects(f.tool('execute_qq_action').execute(input, f.context), /业务引用/)
  const other = f.sessions.create('other')
  f.database.transaction(() => new MonConnectionRepository(f.database).saveInTransaction(other.id,
    { coreBaseUrl: 'https://core.example', coreToken: 'test-only-token' }))
  assert.throws(() => f.client.resolveParams(f.client.target(other.id, '42'), { tid: ref }), /业务引用/)
  assert.equal(f.sent.length, 0)
})

test('failed and unknown receipts preserve business error prose while dropping structured tracking metadata', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  for (const status of ['failed', 'unknown'] as const) {
    const receipt = f.client.modelReceipt(f.client.target(f.session.id, '42'), { request_id: 'internal-trace', action: 'delete_qzone_msg', status,
      code: 'UPSTREAM_ERROR', message: `could not confirm ${rawTid}`, result: { confirmed: false } })
    const view = f.tool('execute_qq_action').modelResult!(receipt) as { status: string; message: string; result: { confirmed: boolean } }
    assert.equal(view.status, status); assert.equal(view.result.confirmed, false)
    assert.equal(view.message, `could not confirm ${rawTid}`); assert.doesNotMatch(JSON.stringify(view), /internal-trace/)
  }
})

test('legacy references survive restart and reject changed connection scope', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-qq-references-'))
  let reopened: EdenDatabase | undefined
  t.after(async () => { reopened?.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }) })
  const filename = path.join(root, 'test.sqlite'), f = qqResultFixture(filename)
  const ref = new QqReferenceRepository(f.sessions).remember(f.client.target(f.session.id, '42'), 'qzone', rawTid)
  const id = f.session.id; f.close()
  const database = new EdenDatabase(filename, 'mon'), sessions = new SessionRepository(database, 'mon')
  reopened = database
  const client = new NapcatClient(sessions)
  assert.equal(client.resolveParams(client.target(id, '42'), { tid: ref }).tid, rawTid)
  database.transaction(() => new MonConnectionRepository(database).saveInTransaction(id,
    { coreBaseUrl: 'https://other-account.example', coreToken: 'other-token' }))
  assert.throws(() => client.resolveParams(client.target(id, '42'), { tid: ref }), /业务引用/)
})

test('new result projection performs no alias writes even when the old alias table is unwritable', async t => {
  const f = qqResultFixture(); t.after(() => f.close())
  f.database.connection.exec("CREATE TRIGGER reject_qq_reference BEFORE INSERT ON qq_action_references BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  const raw = await f.tool('execute_qq_action').execute({ bot_id: '42', action: 'send_qzone_msg', params: { content: '正文' } }, f.context)
  assert.equal((f.tool('execute_qq_action').modelResult!(raw) as { result: { tid: string } }).result.tid, rawTid)
  assert.equal(f.sent.filter(item => item.action === 'send_qzone_msg').length, 1)
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM qq_action_references').get()?.n, 0)
})
