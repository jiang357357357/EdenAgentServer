import assert from 'node:assert/strict'
import test from 'node:test'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { PromptModeRepository } from '../../../src/modules/prompt-mode/index.ts'
import { QqChannelBridge } from '../../../src/modules/qq-channel/bridge.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import type { BlobService } from '../../../src/modules/blobs/index.ts'
import type { AttachmentService } from '../../../src/modules/attachments/index.ts'
import { BUILTIN_PROMPT_MODE_TEMPLATE } from '../../../src/model-prompts/prompt-mode-eden.ts'
import { account, identity, sharedFixture, groupInput } from './qq-shared-support.ts'

function hasMode(request: unknown) {
  const messages = (request as { messages: { role: string; content: unknown }[] }).messages
  return messages.some(message => message.role === 'system' && typeof message.content === 'string'
    && message.content.includes(BUILTIN_PROMPT_MODE_TEMPLATE))
}
function setApp(mode: PromptModeRepository, enabled: boolean) {
  withAccount(account, () => mode.update({ enabled, expectedUpdatedAt: mode.get().updatedAt }))
}
function metadata(database: Awaited<ReturnType<typeof sharedFixture>>['database'], id: string) {
  return JSON.parse(String(database.connection.prepare('SELECT metadata_json FROM inputs WHERE id=?').get(id)?.metadata_json))
}

test('shared QQ uses its own off/on/off snapshot independently of App mode', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: '普通' }, { text: '开启' }, { text: '关闭' }]); t.after(f.close)
  const mode = new PromptModeRepository(f.database)
  setApp(mode, true)
  await f.bridge.submit(groupInput(1)); await f.idle()
  assert.equal(hasMode(f.model.requests[0]), false)
  setApp(mode, false)
  const input = groupInput(2, '200002', 'core-1')
  const accepted = await f.bridge.submit({ ...input, context: { ...input.context, prompt_mode_enabled: true } }) as { input_id: string }
  await f.idle()
  assert.equal(hasMode(f.model.requests[1]), true)
  assert.equal(withAccount(account, () => mode.get()).enabled, false)
  setApp(mode, true)
  const off = groupInput(3, '200001', 'core-2')
  await f.bridge.submit({ ...off, context: { ...off.context, prompt_mode_enabled: false } }); await f.idle()
  assert.equal(hasMode(f.model.requests[2]), false)
  const saved = metadata(f.database, accepted.input_id)
  assert.equal(saved.promptMode.enabled, true)
  assert.equal(saved.promptMode.template, BUILTIN_PROMPT_MODE_TEMPLATE)
  assert.equal(f.sessions.faultCount(), 0)
})

test('private QQ and App mode settings never change one another', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: 'QQ 开启' }, { text: 'App 关闭' }, { text: 'QQ 默认关闭' }, { text: 'App 开启' }])
  const bridge = new QqChannelBridge(identity, f.database, f.sessions, {} as MonBindingService,
    new PermissionService(f.database, f.repository.events), {} as BlobService, {} as AttachmentService)
  t.after(async () => { await bridge.close(); await f.close() })
  const mode = new PromptModeRepository(f.database)
  const privateSession = withAccount(account, () => f.repository.create('私聊', f.session.participants, {}, { purpose: 'user_chat', sourceChannel: 'qq' }))
  f.database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)').run('100001', '200001', privateSession.id, Date.now())
  const input = { schema_version: 'qq-turn.v3', user_id: '7', bot_qq: '100001', contact_qq: '200001',
    assistant_id: 1, character_id: 2, message_id: 'private-on', text: '你好', prompt_mode_enabled: true }
  await bridge.submit(input); await f.sessions.waitForIdle(privateSession.id)
  assert.equal(hasMode(f.model.requests[0]), true)
  assert.equal(withAccount(account, () => mode.get()).enabled, false)
  const app = withAccount(account, () => f.repository.create('App', f.session.participants, {}, { purpose: 'user_chat', sourceChannel: 'app' }))
  await withAccount(account, () => f.sessions.start(app.id, '你好')); await f.sessions.waitForIdle(app.id)
  assert.equal(hasMode(f.model.requests[1]), false)
  setApp(mode, true)
  const { prompt_mode_enabled: _mode, ...legacy } = input
  await bridge.submit({ ...legacy, message_id: 'private-off' }); await f.sessions.waitForIdle(privateSession.id)
  assert.equal(hasMode(f.model.requests[2]), false)
  await withAccount(account, () => f.sessions.start(app.id, '你好')); await f.sessions.waitForIdle(app.id)
  assert.equal(hasMode(f.model.requests[3]), true)
  assert.equal(withAccount(account, () => mode.get()).enabled, true)
})
