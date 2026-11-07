import assert from 'node:assert/strict'
import test from 'node:test'
import { QqSharedRepository } from '../../../src/modules/qq-channel/shared-repository.ts'
import { qqSharedMessageSchema } from '@eden/api'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { account, sharedFixture, groupInput } from './qq-shared-support.ts'

test('A B A keep one conversation and preserve the actual previous model prefix', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: 'A 的第一份方案' }, { text: 'B 的补充方案' }, { text: 'A 的后续' }])
  t.after(f.close)
  const publicMessage = qqSharedMessageSchema.parse({ source_key: 'background', sequence: 1, message_id: 'native-budget',
    role: 'user', sender_qq: '200003', sender_name: 'C', sender_permission: 'none', timestamp: '2026-11-06T12:00:00+08:00', content: '预算五百' })
  new QqSharedRepository(f.database).ingest(f.session.id, [publicMessage])
  const a = await f.bridge.submit(groupInput(2)) as { session_id: string; input_id: string }
  await f.idle()
  new QqSharedRepository(f.database).ingest(f.session.id, [{ ...publicMessage, source_key: 'echo-a', sequence: 3,
    role: 'assistant', sender_qq: '100001', sender_name: 'Alice', content: 'A 的第一份方案', reply_to_input: a.input_id }])
  const b = await f.bridge.submit(groupInput(4, '200002', 'core-2')) as { session_id: string; input_id: string }
  await f.idle()
  await f.bridge.submit(groupInput(5, '200001', 'core-4')); await f.idle()
  assert.equal(a.session_id, b.session_id)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM qq_shared_rooms').get()?.n, 1)
  const payloads = f.model.requests.map(request => request as { messages: { role: string; content: string }[]; tools?: unknown })
  for (let index = 1; index < payloads.length; index++) {
    const previous = payloads[index - 1]!, current = payloads[index]!
    assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages)
    assert.deepEqual(current.tools, previous.tools)
  }
  const last = JSON.stringify(payloads[2])
  assert.equal((last.match(/预算五百/g) ?? []).length, 1)
  assert.equal((last.match(/A 的第一份方案/g) ?? []).length, 1)
  assert.match(last, /A（超级管理员）（200001）/)
  assert.match(last, /B（允许聊天）（200002）/)
  assert.doesNotMatch(last, /source_key|core-2|echo-a/)
  assert.throws(() => f.bridge.status({ ...groupInput(4), input_id: b.input_id }), /unrecognized|Unrecognized/)
  assert.throws(() => f.bridge.status({ user_id: '7', bot_qq: '100001', group_qq: '300001', contact_qq: '200001', input_id: b.input_id }), /not found/)
  const checkpoint = withAccount(account, () => f.repository.checkpoint(f.session.id))
  assert.match(JSON.stringify(checkpoint), /预算五百/)
  assert.equal(f.model.requests.length, 3)
  const cache = f.database.connection.prepare("SELECT payload_json FROM events WHERE kind='model.request' ORDER BY seq DESC LIMIT 1").get()
  const estimate = JSON.parse(String(cache?.payload_json)).contextEstimate
  assert.ok(estimate.commonPrefixMessageCount >= payloads[1]!.messages.length)
  assert.equal(f.sessions.faultCount(), 0)
})

test('replay does not regenerate, change attachments, or admit a missing predecessor', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: '一次回答' }]); t.after(f.close)
  const input = groupInput(1)
  const accepted = await f.bridge.submit(input) as { input_id: string }; await f.idle()
  const replay = await f.bridge.submit(input) as { input_id: string }
  assert.equal(replay.input_id, accepted.input_id)
  await assert.rejects(f.bridge.submit({ ...input, text: '篡改正文' }), /replay/)
  await assert.rejects(f.bridge.submit({ ...input, attachments: [{ blobId: '00000000-0000-4000-8000-000000000001', mime: 'text/plain', filename: 'changed.txt' }],
    quoted_message_id: 'quoted-file' }), /replay/)
  await assert.rejects(f.bridge.submit(groupInput(3, '200002', 'not-accepted')), /Previous/)
  assert.equal(f.model.requests.length, 1)
})
