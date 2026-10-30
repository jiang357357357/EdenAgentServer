import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { MessageDeletion, SessionRepository } from '../../../src/modules/sessions/index.ts'
import { wireEvent } from '../../../src/transport/rpc/session.routes.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'

const imageUrl = process.env.EDEN_STICKER_TEST_IMAGE_URL ?? 'http://127.0.0.1/sticker-fixture.png'
function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'local'); t.after(() => database.close())
  const repository = new SessionRepository(database, 'local'), session = repository.create('Sticker history'), turn = randomUUID()
  const message = (role: string, text: string, actor?: number) => repository.events.append(session.id, turn, 'agent.message_end', {
    messageId: randomUUID(), ...(actor ? { actor: { assistantID: actor } } : {}),
    message: { role, content: [{ type: 'text', text }], ...(actor ? { speaker: { assistantID: actor, assistantName: `Actor ${actor}` } } : {}) },
  })
  const sticker = (actor?: number, standalone = false) => repository.events.append(session.id, turn, 'character.sticker.sent', {
    ...(actor ? { actor: { assistantID: actor } } : {}), ...(standalone ? { presentation: 'standalone.v1' } : {}),
    part: { type: 'sticker', stickerId: 7, characterId: 9, name: '历史表情', url: imageUrl, alt: '测试表情' },
  })
  return { database, repository, session, turn, message, sticker, deletion: new MessageDeletion(repository) }
}

test('legacy and new sticker-only records are paginated as durable messages with usable sticker cursors', t => {
  const f = fixture(t), user = f.message('user', 'USER'), first = f.sticker(), second = f.sticker(undefined, true)
  const latest = f.repository.events.messages(f.session.id, undefined, 1)
  assert.deepEqual(latest.items.map(row => row.id), [second.id]); assert.equal(latest.hasMore, true)
  const older = f.repository.events.messages(f.session.id, latest.nextCursor!, 1)
  assert.deepEqual(older.items.map(row => row.id), [first.id]); assert.equal(older.hasMore, true)
  const oldest = f.repository.events.messages(f.session.id, older.nextCursor!, 1)
  assert.deepEqual(oldest.items.map(row => row.id), [user.id]); assert.equal(oldest.hasMore, false)
})

test('deleting a reply anchored by its sticker removes every phase and never restores the sticker', t => {
  const f = fixture(t); f.message('user', 'USER')
  const first = f.message('assistant', 'BODY'), image = f.sticker(undefined, true)
  const ids = f.deletion.remove(f.session.id, image.id, 'reply').messageIds!
  assert.deepEqual(ids, [(first.payload as any).messageId, image.id])
  assert.deepEqual(f.deletion.remove(f.session.id, image.id, 'reply').messageIds, ids)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 100).items.length, 1)
  assert.ok(f.database.connection.prepare('SELECT 1 FROM events WHERE id=?').get(image.id))
  const other = f.sticker(undefined, true)
  f.deletion.remove(f.session.id, other.id)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 100).items.length, 1)
})

test('old reply tombstones hide legacy companion stickers without hiding another actor or a future standalone send', t => {
  const f = fixture(t), owner = f.message('assistant', 'REMOVED', 1), legacy = f.sticker(1)
  f.message('assistant', 'OTHER', 2); const other = f.sticker(2)
  f.repository.events.append(f.session.id, f.turn, 'message.deleted', {
    messageId: (owner.payload as any).messageId, replyGroupId: 'legacy-group', contextRemoved: true,
  })
  const newSend = f.sticker(1, true)
  const ids = f.repository.events.messages(f.session.id, undefined, 100).items.map(row => row.id)
  assert.ok(!ids.includes(legacy.id)); assert.ok(ids.includes(other.id) && ids.includes(newSend.id))
  assert.deepEqual(f.deletion.readReply(f.session.id, newSend.id).messageIds, [newSend.id])
})

test('ownership, missing cursors and group actor boundaries also cover standalone stickers', t => {
  const f = fixture(t), one = f.sticker(1, true), two = f.sticker(2, true)
  assert.deepEqual(f.deletion.readReply(f.session.id, two.id).messageIds, [two.id])
  assert.throws(() => f.repository.events.messages(f.session.id, randomUUID(), 10), /cursor/)
  const foreign = { key: 'foreign-account', userId: 'other', coreBaseUrl: 'http://fixture/' }
  assert.throws(() => withAccount(foreign, () => f.repository.events.messages(f.session.id, undefined, 10)), /不属于当前账号/)
  f.deletion.remove(f.session.id, one.id, 'reply')
  assert.deepEqual(f.repository.events.messages(f.session.id, undefined, 100).items.map(row => row.id), [two.id])
})

test('a real temporary SQLite reopen restores the original legacy sticker without backfill', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-sticker-reopen-')), filename = path.join(root, 'test.db')
  let database = new EdenDatabase(filename, 'local')
  t.after(() => { database.close(); assert.equal(path.dirname(root), path.resolve(tmpdir())); rmSync(root, { recursive: true, force: true }) })
  const repository = new SessionRepository(database, 'local'), session = repository.create('Reopened sticker'), turn = randomUUID()
  repository.events.append(session.id, turn, 'agent.message_end', { messageId: 'user', message: { role: 'user', content: [{ type: 'text', text: '请发表情' }] } })
  repository.events.append(session.id, turn, 'agent.message_end', { messageId: 'tool', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '查询表情' }, { type: 'toolCall', id: 'call', name: 'send_character_sticker', arguments: { sticker: '7' } }] } })
  const sent = repository.events.append(session.id, turn, 'character.sticker.sent', {
    part: { type: 'sticker', stickerId: 7, characterId: 9, name: '历史表情', url: imageUrl, alt: '测试表情' },
  })
  repository.events.append(session.id, turn, 'agent.message_end', { messageId: 'receipt', message: { role: 'toolResult',
    toolCallId: 'call', toolName: 'send_character_sticker', isError: false, content: [{ type: 'text', text: '已发送' }] } })
  repository.events.append(session.id, turn, 'agent.message_end', { messageId: 'final', message: { role: 'assistant', content: [{ type: 'text', text: '已发送。' }] } })
  database.close(); database = new EdenDatabase(filename, 'local')
  const restored = new SessionRepository(database, 'local'), page = restored.events.messages(session.id, undefined, 100)
  assert.equal(page.items.length, 5); assert.equal(page.items[2]!.id, sent.id)
  assert.equal(page.items[2]!.kind, 'character.sticker.sent')
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='character.sticker.sent'").get()!.n, 1)
  const evidence = process.env.EDEN_STICKER_HISTORY_EVIDENCE
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    writeFileSync(path.join(evidence, 'restored-page.json'), JSON.stringify({ sessionId: session.id, stickerId: sent.id,
      events: page.items.map(wireEvent), hasMore: page.hasMore, nextCursor: page.nextCursor }, null, 2) + '\n')
  }
})
