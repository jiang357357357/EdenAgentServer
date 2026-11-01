import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { STICKER_MAX_BYTES, toJson } from '@eden/api'
import { privateToolHistoryEntries } from '../../../src/modules/tool-results/index.ts'
import { stickerTools } from '../../../src/modules/stickers/index.ts'
import { NapcatClient } from '../../../src/modules/mon/index.ts'
import { AttachmentRepository } from '../../../src/modules/attachments/index.ts'
import { stickerFixture, metadata, gif } from './fixture.ts'

test('QQ saves the current image as a multipart Core sticker, searches its alias and deletes with 204', async t => {
  const f = await stickerFixture('qq'); t.after(() => f.close())
  const saved = await f.execute('remember_character_sticker', { ...metadata, name: '笑哭', blobId: f.attachment.id }) as any
  assert.equal(saved.saved, true)
  const form = f.uploaded[0]!, image = form.get('image') as File
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), gif)
  assert.equal(image.type, 'image/gif')
  assert.deepEqual(JSON.parse(String(form.get('aliases'))), metadata.aliases)
  assert.equal(form.get('intent'), metadata.intent)
  assert.equal(f.requests.find(item => item.method === 'POST' && item.path.includes('stickers/'))!.headers.authorization, 'Token fixture-token')
  const found = await f.execute('list_character_stickers', { query: '笑笑' }) as any
  assert.equal(found.stickers.length, 2, 'aliases participate in search even though Core q does not search aliases')
  await assert.rejects(f.execute('send_character_sticker', { sticker: '笑笑' }), /ambiguous/)
  const deleted = await f.execute('delete_character_sticker', { sticker: String(saved.sticker.id) }) as any
  assert.equal(deleted.deleted, true)
  assert.equal((await f.execute('list_character_stickers', { query: '笑哭' }) as any).stickers.length, 0)
})

test('App emits a durable canonical sticker part; URL imports use no Core authentication headers', async t => {
  const f = await stickerFixture(); t.after(() => f.close())
  await f.execute('remember_character_sticker', { ...metadata, name: '链接图片', imageUrl: f.base + '/image.gif' })
  const imageRequest = f.requests.find(item => item.path === '/image.gif')!
  assert.equal(imageRequest.headers.authorization, undefined)
  const result = await f.execute('send_character_sticker', { sticker: '1' }) as any
  assert.equal(result.channel, 'app'); assert.equal(result.status, 'success')
  const event = f.database.connection.prepare("SELECT payload_json FROM events WHERE kind='character.sticker.sent'").get()!
  assert.equal(JSON.parse(String(event.payload_json)).presentation, 'standalone.v1')
  assert.deepEqual(JSON.parse(String(event.payload_json)).part, { type: 'sticker', stickerId: 1, characterId: 9,
    name: metadata.name, url: f.base + '/image.gif', alt: metadata.description })
  assert.ok(!f.requests.some(item => item.path.includes('qq_bot')))
})

for (const channel of ['qq', 'group'] as const) test(`${channel} sends GIF bytes to only its durable conversation and hides receipts on history restore`, async t => {
  const f = await stickerFixture(channel); t.after(() => f.close())
  const raw = await f.execute('send_character_sticker', { sticker: '高兴' }) as any
  const calls = f.requests.filter(item => item.path.includes('qq_bot')).map(item => JSON.parse(item.body.toString()))
  const write = calls.find(item => item.mode === 'write')
  assert.equal(write.action, channel === 'group' ? 'send_group_sticker' : 'send_private_sticker')
  assert.equal(write.params[channel === 'group' ? 'group_id' : 'user_id'], channel === 'group' ? '333333' : '222222')
  assert.equal(write.params.image_base64, gif.toString('base64'))
  assert.deepEqual(write.qq_context, { session_id: f.session.id, bot_qq: '111111', contact_qq: '222222',
    ...(channel === 'group' ? { group_qq: '333333' } : {}) })
  const projected = f.tool('send_character_sticker').modelResult!(toJson(raw), {}) as any
  assert.equal(projected.sticker.id, 1); assert.equal(projected.status, 'success')
  assert.doesNotMatch(JSON.stringify(projected), /platform-|request_id|receipt|image_base64/)
  const restored = privateToolHistoryEntries([{ message: { role: 'toolResult', toolName: 'send_character_sticker',
    modelSource: 'builtin', toolCallId: 'call1', details: raw, content: [{ type: 'text', text: JSON.stringify(raw) }] } }])
  assert.doesNotMatch(JSON.stringify(restored), /platform-|request_id|image_base64/)
  assert.equal(f.requests.filter(item => item.path === '/image.gif')[0]!.headers.authorization, undefined)
})

for (const status of ['unknown', 'failed', 'disconnect']) test(`QQ ${status} receipt is never retried or projected as sent`, async t => {
  const f = await stickerFixture('qq'); t.after(() => f.close()); f.status(status)
  const raw = await f.execute('send_character_sticker', { sticker: '1' }) as any
  assert.equal(raw.status, status === 'disconnect' ? 'unknown' : status)
  assert.equal(f.requests.filter(item => item.path.includes('qq_bot') && JSON.parse(item.body.toString()).mode === 'write').length, 1)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='character.sticker.sent'").get()!.n, 0)
})

test('permission denial, invalid image, foreign attachment and ambiguous source cause no mutations', async t => {
  const f = await stickerFixture('group'); t.after(() => f.close())
  f.permissions.setQqMode('111111', '222222', 'restricted', '333333')
  const pending = f.execute('remember_character_sticker', { ...metadata, blobId: f.attachment.id })
  await new Promise(resolve => setTimeout(resolve, 0))
  f.permissions.resolve(f.permissions.list().find(item => item.state === 'pending')!.id, false)
  await assert.rejects(pending, /Permission denied/)
  assert.equal(f.requests.length, 0)
  f.database.connection.prepare('UPDATE qq_group_sessions SET allow_actions=1').run()
  f.permissions.setQqMode('111111', '222222', 'full_access', '333333')
  await assert.rejects(f.execute('remember_character_sticker', { ...metadata, blobId: randomUUID() }), /current input/)
  await assert.rejects(f.execute('remember_character_sticker', { ...metadata, blobId: f.attachment.id, imageUrl: f.base + '/image.gif' }), /exactly one/)
  f.image(Buffer.from('not an image'))
  await assert.rejects(f.execute('remember_character_sticker', { ...metadata, imageUrl: f.base + '/image.gif' }), /signature/)
  f.image(Buffer.alloc(STICKER_MAX_BYTES + 1))
  await assert.rejects(f.execute('remember_character_sticker', { ...metadata, imageUrl: f.base + '/image.gif' }), /10 MiB/)
  assert.equal(f.uploaded.length, 0)
})

test('ended input cannot reuse its attachment and a changed binding during QQ capability lookup prevents sending', async t => {
  const f = await stickerFixture('qq'); t.after(() => f.close())
  f.inputs.finish(f.input)
  await assert.rejects(f.execute('remember_character_sticker', { ...metadata, blobId: f.attachment.id }), /active input/)
  f.afterCatalog(() => f.database.connection.prepare("UPDATE mon_connections SET core_token='changed'").run())
  await assert.rejects(f.execute('send_character_sticker', { sticker: '1' }), /changed/)
  assert.ok(!f.requests.some(item => item.path.includes('qq_bot') && JSON.parse(item.body.toString()).mode === 'write'))
})

test('multi-role tools select only the host acting character and persist that actor on the sticker event', async t => {
  const f = await stickerFixture(); t.after(() => f.close())
  f.repository.events.append(f.session.id, null, 'session.metadata.updated', {
    participants: [{ assistantId: 1, characterId: 9 }, { assistantId: 2, characterId: 10 }], environment: null,
  })
  assert.throws(() => f.mon.characterContext(f.session.id), /acting character/)
  const tools = stickerTools(f.mon, new NapcatClient(f.repository), f.repository, f.permissions,
    new AttachmentRepository(f.database), f.attachments, f.session.id, f.input.turnId, 1)
  await tools.find(tool => tool.name === 'send_character_sticker')!.execute({ sticker: '1' }, f.context())
  const event = f.database.connection.prepare("SELECT payload_json FROM events WHERE kind='character.sticker.sent'").get()!
  assert.equal(JSON.parse(String(event.payload_json)).actor.assistantID, 1)
  assert.ok(f.requests.every(item => !item.path.includes('/characters/10/')))
})

test('changing the character while approval waits rejects the stale request before touching Core', async t => {
  const f = await stickerFixture(); t.after(() => f.close()); f.permissions.setMode('restricted')
  const pending = assert.rejects(f.execute('send_character_sticker', { sticker: '1' }), /changed/)
  await new Promise<void>(resolve => setImmediate(resolve))
  const approval = f.permissions.list().find(item => item.state === 'pending')!
  assert.ok(approval)
  f.repository.events.append(f.session.id, null, 'session.metadata.updated', {
    participants: [{ assistantId: 1, characterId: 10 }], environment: null,
  })
  f.permissions.resolve(approval.id, true)
  await pending
  assert.equal(f.requests.length, 0)
})
