import assert from 'node:assert/strict'
import test from 'node:test'
import { recordedModel } from '@eden/runtime-pi/testing'
import { EdenDatabase } from '@eden/store'
import { SkillRepository, builtinSkillSnapshots } from '../../../src/modules/skills/index.ts'
import { rolePolicy, subagentRoles } from '../../../src/modules/subagent-execution/index.ts'
import { createServices } from '../../../src/bootstrap/services.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { stickerFixture, metadata } from './fixture.ts'

for (const channel of ['app', 'qq', 'group'] as const) test(`${channel} actual runtime saves an attachment and invokes the real sticker sender`, { timeout: 30000 }, async t => {
  const f = await stickerFixture(channel); t.after(() => f.close())
  f.inputs.finish(f.input)
  const model = await recordedModel([
    ...(channel === 'app' ? [
      { tool: 'load_skill', input: { name: 'character-stickers' } },
      { tool: 'load_tools', input: { tools: [{ id: 'builtin:remember_character_sticker' }] } },
    ] : []),
    { tool: 'remember_character_sticker', input: { ...metadata, name: '运行时笑脸', blobId: f.attachment.id } },
    { tool: 'list_character_stickers', input: { query: '运行时笑脸' } },
    { tool: 'send_character_sticker', input: { sticker: '运行时笑脸' } }, { text: '已收藏并发送这个表情包' },
    { tool: 'list_character_stickers', input: { query: '运行时笑脸' } }, { text: '下一轮仍可检索' },
  ])
  t.after(() => model.close())
  t.mock.method(f.models, 'resolve', () => model.config)
  await f.sessions.startWithAttachments(f.session.id, '收藏这个表情包再发给我', [{ blobId: f.attachment.id, mime: 'image/gif' }])
  await f.sessions.waitForIdle(f.session.id)
  assert.equal(f.sessions.faultCount(), 0)
  assert.equal(f.uploaded.length, 1)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='character.sticker.sent'").get()!.n, 1)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 100).items.filter(event => event.kind === 'character.sticker.sent').length, 1)
  const receipts = f.database.connection.prepare("SELECT result_json FROM tool_operations WHERE tool_name='send_character_sticker'").all()
  assert.equal(receipts.length, 1)
  assert.equal(JSON.parse(String(receipts[0]!.result_json)).status, 'success')
  const firstTools = (model.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  for (const name of ['list_character_stickers', 'send_character_sticker']) assert.ok(firstTools.includes(name), name)
  if (channel !== 'app') assert.ok(firstTools.includes('remember_character_sticker'))
  assert.equal(firstTools.includes('delete_character_sticker'), channel !== 'app')
  f.sessions.start(f.session.id, '查询刚才收藏的表情包')
  await f.sessions.waitForIdle(f.session.id)
  assert.equal(f.sessions.faultCount(), 0)
  const subsequent = JSON.stringify(model.requests.at(-1)!.messages)
  assert.match(subsequent, /运行时笑脸/)
  assert.doesNotMatch(subsequent, /platform-message-secret|platform-trace-secret|image_base64/)
})

test('the builtin guide is discoverable, local host has no Core tools, and subagents cannot acquire them', async t => {
  const f = await stickerFixture(); t.after(() => f.close())
  const skills = new SkillRepository(f.database, undefined, undefined, undefined, undefined, undefined, builtinSkillSnapshots)
  assert.match(skills.read('character-stickers').content!, /read_attachment/)
  assert.match(skills.read('character-stickers').content!, /unknown/)
  const local = new EdenDatabase(':memory:', 'local'); t.after(() => local.close())
  const services = createServices(local, { ...loadConfig({ EDEN_AGENT_DATA_ROOT: f.root }), origin: 'local' })
  t.after(async () => {
    await services.memoryExtractions.close()
    await Promise.all([services.sessions.close(), services.mon.close(), services.plugins.close(), services.companion.close()])
    services.questions.close()
  })
  assert.ok(f.toolset.every(tool => f.sessions.toolCatalog().some(item => item.name === tool.name)))
  assert.ok(!services.sessions.toolCatalog().some(tool => tool.name.includes('character_sticker')))
  for (const role of subagentRoles()) for (const tool of f.toolset) assert.ok(rolePolicy(role.name).deniedTools.includes(tool.name))
})
