import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'mon'), session = sessions.create('Projections')
  const insert = database.connection.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
  const event = (seq: bigint, kind: string, createdAt = 100, json = '{}') => {
    insert.run(randomUUID(), session.id, null, seq, kind, json, createdAt)
  }
  return { database, sessions, session, event }
}

test('multi-kind projection merges exact BigInt sequence order, deduplicates kinds and preserves page boundaries', t => {
  const f = fixture(t)
  const base = 9007199254740993n
  f.event(base, 'alpha', 500)
  f.event(base + 1n, 'agent.message_update', 600, 'invalid unrelated JSON')
  f.event(base + 2n, 'beta', 400)
  f.event(base + 3n, 'alpha', 300)
  f.event(base + 4n, 'beta', 200)
  f.event(base + 9n, 'agent.message_update', 900)
  const kinds = ['beta', 'alpha', 'beta']
  const first = f.sessions.events.projectionBatch(f.session.id, String(base - 1n), kinds, 2)
  assert.deepEqual(first.events.map(event => event.seq), [String(base), String(base + 2n)])
  assert.equal(first.throughSeq, String(base + 2n))
  const second = f.sessions.events.projectionBatch(f.session.id, first.throughSeq, kinds, 2)
  assert.deepEqual(second.events.map(event => event.seq), [String(base + 3n), String(base + 4n)])
  assert.equal(second.throughSeq, String(base + 4n))
  assert.deepEqual(f.sessions.events.projectionBatch(f.session.id, second.throughSeq, kinds, 2),
    { events: [], throughSeq: String(base + 9n) })
  assert.equal(f.sessions.events.latestSequence(f.session.id), base + 9n)
  assert.equal(f.sessions.events.latestKindTime(f.session.id, kinds), 200)
  assert.equal(f.sessions.events.latestKindSequence(f.session.id, kinds), base + 4n)
  assert.equal(f.sessions.events.latestKindSequence(f.session.id, ['absent']), 0n)
})

test('projection loads payload only for the final merged page, not extra per-kind candidates', t => {
  const f = fixture(t)
  f.event(2n, 'alpha', 100, '{"picked":"first"}')
  f.event(3n, 'alpha', 101, '{"picked":"second"}')
  f.event(4n, 'beta', 102, 'invalid JSON outside the requested page')
  f.event(5n, 'alpha', 103, 'invalid JSON outside each kind limit')
  const page = f.sessions.events.projectionBatch(f.session.id, '1', ['alpha', 'beta'], 2)
  assert.deepEqual(page.events.map(event => event.payload), [{ picked: 'first' }, { picked: 'second' }])
  assert.equal(page.throughSeq, '3')
  assert.throws(() => f.sessions.events.projectionBatch(f.session.id, page.throughSeq, ['alpha', 'beta'], 2))
  assert.equal(f.sessions.events.latestKindTime(f.session.id, ['alpha', 'beta']), 103)
})

test('semantic seeks ignore a long malformed stream tail without SQLite statistics', t => {
  const f = fixture(t)
  f.event(2n, 'semantic', 7)
  f.database.transaction(() => {
    for (let index = 3; index <= 10_002; index++) f.event(BigInt(index), 'agent.message_update', 100, 'invalid unrelated JSON')
  })
  assert.equal(f.database.connection.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
  const page = f.sessions.events.projectionBatch(f.session.id, '1', ['semantic', 'absent'], 10)
  assert.deepEqual(page.events.map(event => event.seq), ['2'])
  assert.equal(page.throughSeq, '10002')
  assert.equal(f.sessions.events.latestKindTime(f.session.id, ['semantic', 'absent']), 7)
})
