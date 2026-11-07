import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { memoCreateSchema, toJson } from '@eden/api'
import { toolModelResult } from '../../../src/modules/tool-results/model-result-catalog.ts'
import { MemoRepository } from '../../../src/modules/memos/index.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'

function fixture(t: TestContext, origin: 'local' | 'mon' = 'local') {
  const database = new EdenDatabase(':memory:', origin), memos = new MemoRepository(database)
  t.after(() => database.close())
  return { database, memos, create: (title: string) => memos.create(memoCreateSchema.parse({ title })) }
}

test('keyset pages traverse more than 200 rows exactly once, including equal update timestamps', t => {
  const f = fixture(t)
  for (let i = 0; i < 435; i++) f.create(`memo-${i}`)
  f.database.connection.prepare('UPDATE memos SET updated_at=?').run(100)
  const ids: number[] = []
  let cursor: string | undefined
  do {
    const page = f.memos.page({ limit: 79, ...(cursor ? { cursor } : {}) })
    assert.equal(page.hasMore, page.nextCursor !== null)
    ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(ids.length, 435)
  assert.equal(new Set(ids).size, 435)
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a))
  assert.equal(f.memos.list(200).length, 200)
  assert.ok(Array.isArray(f.memos.list()))
})

test('search is applied on every page and a cursor cannot silently switch queries', t => {
  const f = fixture(t)
  for (let i = 0; i < 21; i++) f.create(i % 2 ? `needle-${i}` : `other-${i}`)
  const first = f.memos.page({ limit: 3, query: 'needle' })
  assert.equal(first.items.length, 3)
  const next = f.memos.page({ limit: 20, query: 'needle', cursor: first.nextCursor! })
  assert.equal(next.items.length, 7)
  assert.ok(next.items.every(item => item.title.startsWith('needle-')))
  assert.throws(() => f.memos.page({ cursor: first.nextCursor!, query: 'other' }), /游标/)
  assert.throws(() => f.memos.page({ cursor: 'not-a-cursor' }), /游标/)
})

test('pagination rechecks account ownership and rejects a cursor from a different account', t => {
  const f = fixture(t, 'mon')
  const account = (key: string) => ({ key, userId: key, coreBaseUrl: 'http://fixture.invalid' })
  const first = withAccount(account('one'), () => { for (let i = 0; i < 3; i++) f.create(`one-${i}`); return f.memos.page({ limit: 1 }) })
  withAccount(account('two'), () => {
    f.create('two-only')
    assert.deepEqual(f.memos.page().items.map(item => item.title), ['two-only'])
    assert.throws(() => f.memos.page({ cursor: first.nextCursor! }), /游标/)
  })
  assert.equal(withAccount(account('one'), () => f.memos.page().items.length), 3)
})

test('an empty or exhausted page has no continuation, and new rows do not duplicate older pages', t => {
  const f = fixture(t)
  assert.deepEqual(f.memos.page(), { items: [], hasMore: false, nextCursor: null })
  for (let i = 0; i < 4; i++) f.create(`original-${i}`)
  const first = f.memos.page({ limit: 2 })
  f.create('new-row')
  const last = f.memos.page({ limit: 2, cursor: first.nextCursor! })
  assert.equal(last.items.length, 2)
  assert.equal(last.nextCursor, null)
  assert.equal(new Set([...first.items, ...last.items].map(item => item.id)).size, 4)
})

test('the model result contract preserves continuation and the actual reminder delivery policy', t => {
  const f = fixture(t)
  f.create('first'); f.create('second')
  const page = f.memos.page({ limit: 1 })
  const project = toolModelResult('list_memos_page')!
  const result = project(toJson(page), {}) as { nextCursor: string; hasMore: boolean; items: { id: number; delivery: unknown }[] }
  assert.equal(result.nextCursor, page.nextCursor)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.items[0]!.delivery, { channel: 'auto' })
  assert.equal(result.items[0]!.id, page.items[0]!.id)
})
