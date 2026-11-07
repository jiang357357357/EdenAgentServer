import assert from 'node:assert/strict'
import test from 'node:test'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { UiPreferenceRepository } from '../../../src/modules/ui-preferences/index.ts'
import { QqChannelBridge } from '../../../src/modules/qq-channel/bridge.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import type { BlobService } from '../../../src/modules/blobs/index.ts'
import type { AttachmentService } from '../../../src/modules/attachments/index.ts'
import { account, identity, sharedFixture, groupInput } from './qq-shared-support.ts'

function system(request: Record<string, unknown>) {
  return JSON.stringify((request.messages as { role: string; content: unknown }[]).find(message => message.role === 'system')?.content)
}

test('QQ length reaches actual group model requests independently of App character preferences', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: '短回答' }, { text: '长回答' }, { text: '默认中等回答' }]); t.after(f.close)
  const preferences = new UiPreferenceRepository(f.database)
  withAccount(account, () => preferences.updateReplyLength('2', 'long'))
  const first = groupInput(1)
  const accepted = await f.bridge.submit({ ...first, context: { ...first.context, reply_length: 'short' } }) as { input_id: string }; await f.idle()
  assert.match(system(f.model.requests[0]!), /聊天回复长度偏好：简短回答/)
  assert.equal(withAccount(account, () => preferences.replyLength('2')).length, 'long')
  withAccount(account, () => preferences.updateReplyLength('2', 'short'))
  const second = groupInput(2, '200002', 'core-1')
  await f.bridge.submit({ ...second, context: { ...second.context, reply_length: 'long' } }); await f.idle()
  assert.match(system(f.model.requests[1]!), /聊天回复长度偏好：详细展开/)
  assert.equal(withAccount(account, () => preferences.replyLength('2')).length, 'short')
  withAccount(account, () => preferences.updateReplyLength('2', 'long'))
  await f.bridge.submit(groupInput(3, '200001', 'core-2')); await f.idle()
  assert.match(system(f.model.requests[2]!), /聊天回复长度偏好：自然展开/)
  const metadata = JSON.parse(String(f.database.connection.prepare('SELECT metadata_json FROM inputs WHERE id=?').get(accepted.input_id)?.metadata_json))
  assert.deepEqual(metadata.replyLengths, {})
  assert.equal(metadata.channelContext.reply_length, 'short')
  assert.equal(f.sessions.faultCount(), 0)
})

test('private QQ and App requests for the same character use their own length setting', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: 'QQ 回答' }, { text: 'App 回答' }])
  const bridge = new QqChannelBridge(identity, f.database, f.sessions, {} as MonBindingService,
    new PermissionService(f.database, f.repository.events), {} as BlobService, {} as AttachmentService)
  t.after(async () => { await bridge.close(); await f.close() })
  const preferences = new UiPreferenceRepository(f.database)
  withAccount(account, () => preferences.updateReplyLength('2', 'long'))
  const privateSession = withAccount(account, () => f.repository.create('私聊', f.session.participants, {}, { purpose: 'user_chat', sourceChannel: 'qq' }))
  f.database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)').run('100001', '200001', privateSession.id, Date.now())
  await bridge.submit({ schema_version: 'qq-turn.v3', user_id: '7', bot_qq: '100001', contact_qq: '200001',
    assistant_id: 1, character_id: 2, message_id: 'private-length', text: '你好', reply_length: 'short' })
  await f.sessions.waitForIdle(privateSession.id)
  assert.match(system(f.model.requests[0]!), /聊天回复长度偏好：简短回答/)
  const app = withAccount(account, () => f.repository.create('App', f.session.participants, {}, { purpose: 'user_chat', sourceChannel: 'app' }))
  await withAccount(account, () => f.sessions.start(app.id, '你好')); await f.sessions.waitForIdle(app.id)
  assert.match(system(f.model.requests[1]!), /聊天回复长度偏好：详细展开/)
  assert.equal(withAccount(account, () => preferences.replyLength('2')).length, 'long')
})
