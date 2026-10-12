import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { rpcMethods, type DurableEvent } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { MessageDeletion, SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'local')
  t.after(() => database.close())
  const repository = new SessionRepository(database, 'local'), session = repository.create('Delete fixture')
  const deletion = new MessageDeletion(repository)
  const append = (role = 'assistant', messageId = randomUUID(), sessionId = session.id) => ({
    messageId,
    event: repository.events.append(sessionId, null, 'agent.message_end', {
      messageId, message: { role, content: [{ type: 'text', text: `${role} fixture` }] },
    }),
  })
  return { database, repository, session, deletion, append }
}

test('deleting one answer commits before publication and preserves other messages, audit and checkpoint', t => {
  const f = fixture(t), user = f.append('user'), first = f.append(), second = f.append()
  const checkpoint = { format: 'eden.pi-harness.v1' as const, runtimeVersion: '0.82.0' as const,
    sessionId: f.session.id, createdAt: new Date().toISOString(), entries: [] }
  f.repository.saveCheckpoint(checkpoint, randomUUID())
  const published: DurableEvent[] = []
  f.repository.events.subscribe(event => {
    if (event.kind !== 'message.deleted') return
    assert.ok(f.database.connection.prepare('SELECT 1 FROM events WHERE id=?').get(event.id))
    published.push(event)
  })
  assert.deepEqual(f.deletion.remove(f.session.id, first.messageId), { sessionId: f.session.id, messageId: first.messageId, deleted: true })
  assert.deepEqual(f.repository.events.messages(f.session.id, undefined, 10).items.map(event => event.id), [user.event.id, second.event.id])
  assert.equal(f.repository.read(f.session.id).status, 'active')
  assert.ok(f.database.connection.prepare('SELECT 1 FROM events WHERE id=?').get(first.event.id))
  assert.deepEqual(f.repository.checkpoint(f.session.id), checkpoint)
  assert.equal(published.length, 1)
  f.deletion.remove(f.session.id, first.messageId)
  assert.equal(published.length, 1, 'retry after an unconfirmed acknowledgement must not duplicate deletion')
})

test('pagination excludes deleted answers and a previously issued deleted cursor remains usable', t => {
  const f = fixture(t), messages = Array.from({ length: 5 }, () => f.append())
  const before = messages[3]!.event.id
  f.deletion.remove(f.session.id, messages[3]!.messageId)
  f.deletion.remove(f.session.id, messages[1]!.messageId)
  const newest = f.repository.events.messages(f.session.id, undefined, 2)
  assert.deepEqual(newest.items.map(event => event.id), [messages[2]!.event.id, messages[4]!.event.id])
  assert.equal(newest.hasMore, true)
  const older = f.repository.events.messages(f.session.id, before, 10)
  assert.deepEqual(older.items.map(event => event.id), [messages[0]!.event.id, messages[2]!.event.id])
  assert.equal(older.hasMore, false)
})

test('legacy event IDs are supported while user, tool result, incomplete and foreign-session messages reject', t => {
  const f = fixture(t), foreign = f.repository.create('Other session'), other = f.append('assistant', randomUUID(), foreign.id)
  for (const candidate of [f.append('user'), f.append('toolResult')]) {
    assert.throws(() => f.deletion.remove(f.session.id, candidate.messageId), /只能删除/)
  }
  const pending = randomUUID()
  f.repository.events.append(f.session.id, null, 'agent.message_start', { messageId: pending, message: { role: 'assistant', content: [] } })
  for (const id of [pending, randomUUID(), other.messageId]) assert.throws(() => f.deletion.remove(f.session.id, id), /不存在或尚未完成/)
  const invalid = f.repository.events.append(f.session.id, null, 'agent.message_end', null)
  assert.throws(() => f.deletion.remove(f.session.id, invalid.id), /只能删除/)
  const legacy = f.repository.events.append(f.session.id, null, 'agent.message_end', { message: { role: 'assistant', content: [] } })
  f.deletion.remove(f.session.id, legacy.id)
  assert.ok(!f.repository.events.messages(f.session.id, undefined, 10).items.some(event => event.id === legacy.id))
  assert.equal(f.repository.events.messages(foreign.id, undefined, 10).items.length, 1)
})

test('queued execution prevents deletion without removing the answer', t => {
  const f = fixture(t), answer = f.append()
  new InputRepository(f.database, f.repository.events).enqueue(f.session.id, 'queued fixture', randomUUID())
  assert.throws(() => f.deletion.remove(f.session.id, answer.messageId), /等待当前回答结束/)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 10).items.length, 1)
})

test('deletion RPC uses the public contract and rejects mutation while another configuration owns the session', async t => {
  const f = fixture(t), answer = f.append(), service = new SessionService(f.repository, undefined)
  t.after(() => service.close())
  const routes = sessionRoutes(service), params = { sessionId: f.session.id, messageId: answer.messageId }
  assert.throws(() => rpcMethods['message.delete'].params.parse({ ...params, unexpected: true }))
  let release!: () => void
  const pending = service.configureWhileIdle(f.session.id, () => new Promise<void>(resolve => { release = resolve }))
  await assert.rejects(async () => routes['message.delete']!(params), /Wait for the session/)
  release(); await pending
  assert.deepEqual(rpcMethods['message.delete'].result.parse(await routes['message.delete']!(params)), { ...params, deleted: true })
})

test('deleted answers stay removed after closing and reopening a temporary SQLite database', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'eden-message-deletion-')), filename = join(scratch, 'fixture.sqlite')
  let database = new EdenDatabase(filename, 'local')
  t.after(() => {
    database.close()
    if (dirname(resolve(scratch)) !== resolve(tmpdir())) throw new Error('Unexpected test cleanup path')
    rmSync(scratch, { recursive: true, force: true })
  })
  const repository = new SessionRepository(database, 'local'), session = repository.create('Persistence')
  const event = repository.events.append(session.id, null, 'agent.message_end', { message: { role: 'assistant', content: [] } })
  new MessageDeletion(repository).remove(session.id, event.id)
  database.close(); database = new EdenDatabase(filename, 'local')
  assert.equal(new SessionRepository(database, 'local').events.messages(session.id, undefined, 10).items.length, 0)
})

test('session ownership and runtime origin are checked before deletion', t => {
  const f = fixture(t)
  const owner = { key: '["http://core.fixture/","owner"]', userId: 'owner', coreBaseUrl: 'http://core.fixture/' }
  const other = { ...owner, key: '["http://core.fixture/","other"]', userId: 'other' }
  const owned = withAccount(owner, () => f.repository.create('Owned fixture'))
  const answer = f.append('assistant', randomUUID(), owned.id)
  assert.throws(() => withAccount(other, () => f.deletion.remove(owned.id, answer.messageId)), /不属于当前账号/)
  assert.throws(() => new MessageDeletion(new SessionRepository(f.database, 'mon')).remove(owned.id, answer.messageId), /Session not found/)
  assert.equal(withAccount(owner, () => f.repository.events.messages(owned.id, undefined, 10)).items.length, 1)
  withAccount(owner, () => f.deletion.remove(owned.id, answer.messageId))
  assert.equal(withAccount(owner, () => f.repository.events.messages(owned.id, undefined, 10)).items.length, 0)
})

test('a failed deletion commit rolls back state and does not broadcast removal', t => {
  const f = fixture(t), answer = f.append(), published: DurableEvent[] = []
  f.repository.events.subscribe(event => published.push(event))
  t.mock.method(f.repository.events, 'insert', () => { throw new Error('fixture write failure') })
  assert.throws(() => f.deletion.remove(f.session.id, answer.messageId), /fixture write failure/)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 10).items.length, 1)
  assert.equal(published.length, 0)
})
