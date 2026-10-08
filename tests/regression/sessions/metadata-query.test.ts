import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'

function fixture(t: TestContext, title = '') {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'mon')
  const session = sessions.create(title, [{ assistantId: 1 }], { value: 'created' })
  return { database, sessions, session }
}

function traceQueries(t: TestContext, database: EdenDatabase) {
  const queries: string[] = [], original = database.connection.prepare
  database.connection.prepare = function (sql) { queries.push(sql); return original.call(this, sql) }
  t.after(() => { database.connection.prepare = original })
  return queries
}

test('metadata heads follow event sequence even when session timestamp and event times do not increase', t => {
  const f = fixture(t)
  const before = f.sessions.readMetadata(f.session.id)
  const originalUpdatedAt = f.database.connection.prepare('SELECT updated_at FROM sessions WHERE id=?').get(f.session.id)!.updated_at
  const event = f.sessions.events.append(f.session.id, null, 'session.metadata.updated', {
    participants: [{ assistantId: 2 }], environment: { value: 'updated' },
  })
  f.database.connection.prepare('UPDATE events SET created_at=? WHERE id=?').run(1, event.id)
  assert.equal(f.database.connection.prepare('SELECT updated_at FROM sessions WHERE id=?').get(f.session.id)!.updated_at, originalUpdatedAt)
  const metadata = f.sessions.readMetadata(f.session.id)
  assert.deepEqual(metadata, { participants: [{ assistantId: 2 }], environment: { value: 'updated' }, metadataSeq: event.seq, metadataUpdatedAt: 1 })
  assert.notEqual(metadata.metadataSeq, before.metadataSeq)
  metadata.participants.push({ assistantId: 3 })
  assert.deepEqual(f.sessions.read(f.session.id).participants, [{ assistantId: 2 }])
  assert.deepEqual(f.sessions.read(f.session.id).environment, { value: 'updated' })
})

test('title source preserves fallback, generated, legacy rename and later title event precedence', t => {
  const f = fixture(t)
  const turnId = randomUUID()
  assert.equal(f.sessions.read(f.session.id).titleSource, 'pending')
  assert.equal(f.sessions.setFallbackTitle(f.session.id, 'Fallback', turnId), true)
  assert.equal(f.sessions.read(f.session.id).titleSource, 'fallback')
  assert.equal(f.sessions.setGeneratedTitle(f.session.id, 'Generated', turnId), true)
  assert.equal(f.sessions.read(f.session.id).titleSource, 'generated')
  f.sessions.events.append(f.session.id, null, 'session.renamed', { title: 'Legacy' })
  assert.equal(f.sessions.read(f.session.id).titleSource, 'user')
  assert.equal(f.sessions.setGeneratedTitle(f.session.id, 'Must not replace user title', turnId), false)
  f.sessions.events.append(f.session.id, null, 'session.title_updated', { titleSource: 'generated' })
  assert.equal(f.sessions.read(f.session.id).titleSource, 'generated')
  assert.equal(f.sessions.rename(f.session.id, 'Manual').titleSource, 'user')
})

test('metadata and title candidate comparisons retain adjacent sequence values above Number precision', t => {
  const f = fixture(t)
  const insert = f.database.connection.prepare('INSERT INTO events VALUES(?,?,NULL,?,?,?,?)')
  const low = 9_007_199_254_740_992n, high = low + 1n
  insert.run('large-created', f.session.id, low, 'session.created', JSON.stringify({ participants: [{ assistantId: 1 }] }), 99)
  insert.run('large-metadata', f.session.id, high, 'session.metadata.updated', JSON.stringify({ participants: [{ assistantId: 2 }], environment: { selected: true } }), 1)
  insert.run('large-title', f.session.id, high + 3n, 'session.title_updated', JSON.stringify({ titleSource: 'generated' }), 99)
  insert.run('large-rename', f.session.id, high + 4n, 'session.renamed', '{}', 1)
  assert.equal(f.sessions.readMetadata(f.session.id).metadataSeq, String(high))
  assert.equal(f.sessions.readMetadata(f.session.id).metadataUpdatedAt, 1)
  assert.deepEqual(f.sessions.read(f.session.id).participants, [{ assistantId: 2 }])
  assert.equal(f.sessions.read(f.session.id).titleSource, 'user')
})

test('missing metadata and title kinds retain legacy defaults', t => {
  const f = fixture(t, 'Legacy stored title')
  f.database.connection.prepare('DELETE FROM events WHERE session_id=?').run(f.session.id)
  assert.deepEqual(f.sessions.readMetadata(f.session.id), {
    participants: [], environment: null, metadataSeq: '0', metadataUpdatedAt: f.session.createdAt,
  })
  assert.equal(f.sessions.read(f.session.id).titleSource, 'user')
  f.database.connection.prepare("UPDATE sessions SET title='' WHERE id=?").run(f.session.id)
  assert.equal(f.sessions.read(f.session.id).titleSource, 'pending')
})

test('lightweight metadata read never queries usage, titles or the input queue', t => {
  const f = fixture(t)
  f.sessions.events.append(f.session.id, null, 'model.response', { usage: { input: 10, output: 20 } })
  const queries = traceQueries(t, f.database)
  assert.deepEqual(f.sessions.readMetadata(f.session.id).participants, [{ assistantId: 1 }])
  assert.equal(queries.length, 2)
  assert.match(queries[0]!, /SELECT created_at FROM sessions/)
  assert.match(queries[1]!, /WHERE session_id=\? AND kind=\? ORDER BY seq DESC LIMIT 1/)
  assert.ok(queries.every(sql => !/inputs|model\.response|title|json_extract/.test(sql)))
})

test('lightweight and complete reads preserve account, origin and deleted-session boundaries', t => {
  const f = fixture(t)
  const account = (userId: string) => ({ userId, coreBaseUrl: 'http://fixture.invalid', key: accountKey('http://fixture.invalid', userId) })
  const owner = account('owner'), stranger = account('stranger')
  const session = withAccount(owner, () => f.sessions.create('Private'))
  const reads: Array<() => unknown> = [() => f.sessions.readMetadata(session.id), () => f.sessions.read(session.id)]
  for (const read of reads) {
    assert.throws(() => withAccount(stranger, read), /不属于当前账号/)
    assert.doesNotThrow(() => withAccount(owner, read))
  }
  const count = () => f.database.connection.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id=?').get(session.id)!.n
  const before = count()
  assert.throws(() => withAccount(stranger, () => f.sessions.rename(session.id, 'stolen')), /不属于当前账号/)
  assert.equal(f.sessions.read(session.id).title, 'Private')
  assert.equal(count(), before)
  assert.throws(() => new SessionRepository(f.database, 'local').readMetadata(session.id), /Session not found/)
  assert.throws(() => new SessionRepository(f.database, 'local').read(session.id), /Session not found/)
  assert.throws(() => new SessionRepository(f.database, 'local').rename(session.id, 'wrong origin'), /Session not found/)
  assert.equal(count(), before)
  f.sessions.setStatus(session.id, 'closed')
  assert.doesNotThrow(() => f.sessions.readMetadata(session.id))
  f.sessions.setStatus(session.id, 'deleted')
  assert.throws(() => f.sessions.readMetadata(session.id), /Session not found/)
  assert.throws(() => f.sessions.read(session.id), /Session not found/)
  const deletedCount = count()
  assert.throws(() => f.sessions.rename(session.id, 'deleted rename'), /Session not found/)
  assert.equal(count(), deletedCount)
})

test('sparse metadata and absent title kinds use exact index endpoints without statistics or stream scans', t => {
  const f = fixture(t)
  f.sessions.setMetadata(f.session.id, [{ assistantId: 9 }], { value: 'early-update' })
  f.database.connection.prepare(`WITH RECURSIVE stream(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM stream WHERE n<120002)
    INSERT INTO events SELECT 'sparse-'||n,?,NULL,n,'agent.message_update','not JSON',n FROM stream`).run(f.session.id)
  assert.equal(f.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
  const queries = traceQueries(t, f.database)
  const summary = f.sessions.read(f.session.id)
  assert.deepEqual(summary.participants, [{ assistantId: 9 }])
  assert.deepEqual(summary.environment, { value: 'early-update' })
  assert.equal(summary.titleSource, 'pending')
  assert.equal(f.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
  const heads = [...new Set(queries.filter(sql => sql.includes('SELECT seq,payload_json,created_at FROM events')))]
  assert.equal(heads.length, 1)
  for (const kind of ['session.created', 'session.metadata.updated', 'session.title_updated', 'session.renamed']) {
    const plan = f.database.connection.prepare(`EXPLAIN QUERY PLAN ${heads[0]}`).all(f.session.id, kind).map(row => row.detail).join('\n')
    assert.match(plan, /events_session_kind_seq \(session_id=\? AND kind=\?\)/)
    assert.doesNotMatch(plan, /sqlite_autoindex_events_2|SCAN events|TEMP B-TREE/)
  }
})
