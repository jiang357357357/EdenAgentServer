import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { withAccount, accountKey } from '../../../src/modules/accounts/index.ts'
import { MemoryRepository, MemoryRecall, MemoryScopes } from '../../../src/modules/memories/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import type { MemoryRetriever } from '../../../src/modules/memories/index.ts'

const account = (id: string) => ({ userId: id, coreBaseUrl: 'http://localhost:40011', key: accountKey('http://localhost:40011', id) })
const scope = { scopeType: 'agent_character' as const, scopeKey: '11' }

function fixture(context: test.TestContext) {
  const db = new EdenDatabase(':memory:', 'mon')
  context.after(() => db.close())
  const sessions = new SessionRepository(db, 'mon'), memories = new MemoryRepository(db)
  const session = sessions.create('fixture', [{ assistantId: 1, characterId: 11 }])
  const inputs = new InputRepository(db, sessions.events)
  inputs.enqueue(session.id, 'query', 'fixture', { participants: session.participants })
  const input = inputs.claim(session.id)!
  const recall = (retrieve: MemoryRetriever) => new MemoryRecall(memories, new MemoryScopes(db), retrieve)
  return { db, sessions, session, memories, input, recall }
}

test('recall passes all owned candidates, excludes expiry, and injects only a verified matching excerpt', async context => withAccount(account('first'), async () => {
  const f = fixture(context)
  const old = f.memories.create(scope, '背景。'.repeat(800) + '用户不吃辣。')
  for (let index = 0; index < 105; index++) f.memories.create(scope, `noise ${index}`)
  f.memories.create(scope, 'expired', 'fact', '', { validUntil: Date.now() - 1000 })
  f.memories.create(scope, 'invalid expiry', 'fact', '', { validUntil: 'invalid' })
  f.memories.create({ ...scope, scopeKey: '22' }, 'other character')
  await withAccount(account('second'), async () => { f.memories.create(scope, 'other account') })
  const result = await f.recall(async request => {
    assert.equal(request.candidates.length, 106)
    assert.ok(request.candidates.every(memory => !/expired|invalid expiry|other/.test(memory.content)))
    return [{ id: old.id, similarity: 0.99, excerpt: '用户不吃辣。' }]
  }).prompt(f.session.id, f.input.turnId, '晚餐')
  assert.match(result, /用户不吃辣/)
  assert.doesNotMatch(result, /背景/)
  assert.match(f.memories.read(scope, old.id).content, /背景/)
}))

test('changed and deleted candidates are rejected after asynchronous retrieval', async context => withAccount(account('first'), async () => {
  const f = fixture(context)
  const changed = f.memories.create(scope, 'old content'), removed = f.memories.create(scope, 'deleted content')
  const result = await f.recall(async () => {
    f.memories.update(scope, changed.id, changed.updatedAt, 'new content')
    f.memories.forget(scope, removed.id, removed.updatedAt)
    return [{ id: changed.id, similarity: 1 }, { id: removed.id, similarity: 1 }]
  }).prompt(f.session.id, f.input.turnId, 'query')
  assert.equal(result, '')
}))

test('unavailable retrieval reports unavailable, weak retrieval returns empty, cancellation propagates', async context => withAccount(account('first'), async () => {
  const f = fixture(context)
  const memory = f.memories.create(scope, 'PRIVATE_OLD_DIAGNOSTIC')
  const failed = await f.recall(async () => { throw new Error('fixture timeout') }).prompt(f.session.id, f.input.turnId, 'query')
  assert.match(failed, /暂时不可用/); assert.doesNotMatch(failed, /PRIVATE_OLD_DIAGNOSTIC/)
  assert.equal(await f.recall(async () => []).prompt(f.session.id, f.input.turnId, 'query'), '')
  const invalid = await f.recall(async () => [{ id: memory.id, similarity: 1, excerpt: 'fabricated content' }]).prompt(f.session.id, f.input.turnId, 'query')
  assert.match(invalid, /暂时不可用/)
  const controller = new AbortController()
  await assert.rejects(f.recall(async () => { controller.abort(); return [] }).prompt(f.session.id, f.input.turnId, 'query', undefined, controller.signal), /abort/i)
}))
