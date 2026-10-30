import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { rpcMethods, type JsonValue } from '@eden/api'
import { MessageDeletion, SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'local'); t.after(() => database.close())
  const repository = new SessionRepository(database, 'local'), session = repository.create('Reply group fixture')
  const deletion = new MessageDeletion(repository), turn = randomUUID()
  function append(text: string, options: { turn?: string | null; assistant?: number; role?: string; extra?: Record<string, JsonValue> } = {}) {
    const id = randomUUID(), role = options.role ?? 'assistant'
    repository.events.append(session.id, options.turn === undefined ? turn : options.turn, 'agent.message_end', { messageId: id,
      ...(options.assistant ? { actor: { assistantID: options.assistant } } : {}), message: { role,
        content: [{ type: 'text', text }], ...options.extra,
        ...(options.assistant ? { speaker: { assistantID: options.assistant, assistantName: `Actor ${options.assistant}` } } : {}) } })
    return id
  }
  return { database, repository, session, deletion, append, turn }
}

test('whole reply copy and atomic deletion include all phases while preserving users, tools audit and other turns', t => {
  const f = fixture(t), user = f.append('USER', { role: 'user' })
  const first = f.append('**FIRST**', { extra: { content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: '**FIRST**' },
    { type: 'toolCall', id: 'fixture-call', name: 'fixture', arguments: { secret: 'NO_COPY' } }] } })
  f.append('RAW_TOOL_RECEIPT', { role: 'toolResult' })
  const second = f.append('SECOND'), sticker = f.append('', { extra: { content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }] } })
  const other = f.append('OTHER_TURN', { turn: randomUUID() })
  assert.deepEqual(f.deletion.readReply(f.session.id, sticker), { sessionId: f.session.id, messageId: sticker,
    messageIds: [first, second, sticker], text: '**FIRST**\n\nSECOND' })
  let notifications = 0
  f.repository.events.subscribe(event => {
    if (event.kind !== 'message.deleted') return
    const visible = f.repository.events.messages(f.session.id, undefined, 100).items.map(row => (row.payload as any).messageId)
    assert.deepEqual(visible.filter(id => [first, second, sticker].includes(id)), [], 'all phases commit before the first broadcast')
    notifications++
  })
  const removed = f.deletion.remove(f.session.id, sticker, 'reply')
  assert.deepEqual(removed.messageIds, [first, second, sticker]); assert.equal(notifications, 3)
  assert.deepEqual(f.deletion.remove(f.session.id, second, 'reply').messageIds, removed.messageIds)
  assert.equal(notifications, 3)
  const visible = f.repository.events.messages(f.session.id, undefined, 100).items.map(row => (row.payload as any).messageId)
  assert.ok(visible.includes(user) && visible.includes(other))
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='agent.message_end'").get()!.n, 6)
  assert.match(String(f.database.connection.prepare("SELECT payload_json FROM events WHERE json_extract(payload_json,'$.message.role')='toolResult'").get()!.payload_json), /RAW_TOOL_RECEIPT/)
})

test('reply selection crosses the 100-message UI page boundary and preserves exact body Markdown', t => {
  const f = fixture(t); f.append('USER', { role: 'user' })
  const ids = Array.from({ length: 125 }, (_, i) => f.append(`**part ${i}**\n  indentation`))
  const result = f.deletion.readReply(f.session.id, ids.at(-1)!)
  assert.deepEqual(result.messageIds, ids); assert.match(result.text, /^\*\*part 0\*\*\n  indentation/)
  assert.match(result.text, /\*\*part 124\*\*\n  indentation$/)
  assert.equal(f.deletion.remove(f.session.id, ids.at(-1)!, 'reply').messageIds!.length, 125)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 100).items.length, 1)
})

test('actor, turn, user and compaction boundaries are respected; hidden messages do not split a reply', t => {
  const f = fixture(t)
  const one = f.append('ONE', { assistant: 1 }), two = f.append('TWO', { assistant: 2 })
  const three = f.append('THREE', { assistant: 1 }), otherTurn = f.append('OTHER', { assistant: 1, turn: randomUUID() })
  assert.deepEqual(f.deletion.readReply(f.session.id, three).messageIds, [three])
  assert.deepEqual(f.deletion.readReply(f.session.id, two).messageIds, [two])
  assert.deepEqual(f.deletion.readReply(f.session.id, otherTurn).messageIds, [otherTurn])
  f.deletion.remove(f.session.id, two)
  assert.deepEqual(f.deletion.readReply(f.session.id, three).messageIds, [one, three])
  f.repository.events.append(f.session.id, f.turn, 'agent.session_compact', { compactionEntry: { summary: 'SUMMARY' } })
  const after = f.append('AFTER')
  f.append('HIDDEN', { extra: { display: false } }); f.append('HANDOFF', { extra: { internalHandoff: true } })
  const last = f.append('LAST')
  assert.deepEqual(f.deletion.readReply(f.session.id, last).messageIds, [after, last])
  const user = f.append('BREAK', { role: 'user' }), next = f.append('NEXT')
  assert.deepEqual(f.deletion.readReply(f.session.id, next).messageIds, [next])
  assert.throws(() => f.deletion.readReply(f.session.id, user), /不存在或尚未完成/)
})

test('a failure after the first group tombstone rolls back every deletion and publishes nothing', t => {
  const f = fixture(t), first = f.append('FIRST'), last = f.append('LAST')
  const original = f.repository.events.insert.bind(f.repository.events), published: unknown[] = []
  let writes = 0
  t.mock.method(f.repository.events, 'insert', (...args: Parameters<typeof original>) => {
    if (++writes === 2) throw new Error('second write failed')
    return original(...args)
  })
  f.repository.events.subscribe(event => published.push(event))
  assert.throws(() => f.deletion.remove(f.session.id, last, 'reply'), /second write failed/)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='message.deleted'").get()!.n, 0)
  assert.equal(published.length, 0)
  assert.deepEqual(f.deletion.readReply(f.session.id, first).messageIds, [first, last])
})

test('group RPC contracts, ownership, idle lock and strict parameters cover both reading and deleting', async t => {
  const f = fixture(t), first = f.append('FIRST'), last = f.append('LAST'), service = new SessionService(f.repository, undefined)
  t.after(() => service.close())
  const routes = sessionRoutes(service), params = { sessionId: f.session.id, messageId: last }
  assert.throws(() => rpcMethods['message.delete'].params.parse({ ...params, scope: 'all' }))
  assert.throws(() => rpcMethods['message.reply.read'].params.parse({ ...params, other: true }))
  const read = rpcMethods['message.reply.read'].result.parse(await routes['message.reply.read']!(params))
  assert.deepEqual(read.messageIds, [first, last])
  const wrong = { key: 'foreign-account', userId: 'other', coreBaseUrl: 'http://fixture/' }
  assert.throws(() => withAccount(wrong, () => f.deletion.readReply(f.session.id, last)), /不属于当前账号/)
  const queued = new InputRepository(f.database, f.repository.events).enqueue(f.session.id, 'queued', randomUUID())
  await assert.rejects(async () => routes['message.delete']!({ ...params, scope: 'reply' }), /等待当前回答|Wait for/)
  assert.equal(queued.sessionId, f.session.id)
})

test('legacy null-turn groups stop at user inputs and remain idempotent', t => {
  const f = fixture(t), before = f.append('BEFORE', { turn: null })
  f.append('USER', { role: 'user', turn: null })
  const first = f.append('FIRST', { turn: null }), last = f.append('LAST', { turn: null })
  assert.deepEqual(f.deletion.remove(f.session.id, last, 'reply').messageIds, [first, last])
  assert.deepEqual(f.deletion.remove(f.session.id, first, 'reply').messageIds, [first, last])
  assert.deepEqual(f.deletion.readReply(f.session.id, before).messageIds, [before])
})
