import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { migrations } from '@eden/store/testing'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'

function previousSchema(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'eden-model-head-migration-'))
  const filename = path.join(directory, 'fixture.sqlite'), connection = new DatabaseSync(filename)
  connection.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
  for (const sql of migrations.slice(0, 129)) connection.exec(sql)
  connection.exec("PRAGMA user_version=129; INSERT INTO realm_meta VALUES('origin','mon'); COMMIT")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const session = randomUUID()
  connection.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(session, 'Old history', 'mon', 'active', 0, 0)
  return { filename, connection, session }
}

function oldAggregation(db: DatabaseSync, session: string) {
  const query = db.prepare(`SELECT seq FROM events WHERE session_id=? AND seq IN
    (SELECT MAX(seq) FROM events WHERE session_id=? AND kind='model.request'
      GROUP BY COALESCE(CAST(json_extract(payload_json,'$.actor.assistantID') AS TEXT),''))
    ORDER BY seq DESC LIMIT 32`)
  query.setReadBigInts(true)
  return query.all(session, session).map(row => String(row.seq))
}

test('version 129 backfills once, including sparse invalid streams, then uses bounded index plans without statistics', t => {
  const f = previousSchema(t), raw = f.connection
  raw.exec('BEGIN IMMEDIATE')
  raw.prepare(`WITH RECURSIVE item(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM item WHERE n<120000)
    INSERT INTO events SELECT 'old-stream-'||n,?,NULL,1000000+n,'agent.message_update','not JSON',0 FROM item`).run(f.session)
  raw.prepare(`WITH RECURSIVE item(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM item WHERE n<12000)
    INSERT INTO events SELECT '00000000-0000-4000-8000-'||printf('%012d',n),?,NULL,n,'model.request',
      json_object('actor',json_object('assistantID','actor-'||(n%40)),'contextEstimate',json_object('epoch',n)),0 FROM item`).run(f.session)
  raw.prepare(`WITH RECURSIVE item(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM item WHERE n<12000)
    INSERT INTO events SELECT 'old-response-'||n,?,NULL,20000+n,'model.response',
      CASE WHEN n=1 THEN '{"usage":{"input":9,"output":1}}' ELSE '{"usage":null}' END,0 FROM item`).run(f.session)
  raw.exec('COMMIT')
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
  const start = performance.now(), expected = oldAggregation(raw, f.session)
  for (let count = 1; count < 20; count++) oldAggregation(raw, f.session)
  const oldMilliseconds = performance.now() - start
  raw.close()
  const migrationStart = performance.now(), database = new EdenDatabase(f.filename, 'mon')
  const migrationMilliseconds = performance.now() - migrationStart
  try {
    assert.equal(database.connection.prepare('PRAGMA user_version').get()!.user_version, migrations.length)
    assert.equal(database.connection.prepare('SELECT count(*) AS n FROM session_model_request_heads').get()!.n, 40)
    assert.equal(database.connection.prepare('SELECT count(*) AS n FROM session_model_usage_heads').get()!.n, 1)
    assert.equal(database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
    const sessions = new SessionRepository(database, 'mon'), queries: string[] = []
    const prepare = database.connection.prepare.bind(database.connection)
    database.connection.prepare = sql => { queries.push(sql); return prepare(sql) }
    const currentStart = performance.now()
    for (let count = 0; count < 20; count++) {
      assert.deepEqual(sessions.events.latestContextRequests(f.session).map(event => event.seq), expected)
      assert.equal(sessions.events.latestActorContextEstimate(f.session, 'missing'), undefined)
      assert.equal(sessions.read(f.session).contextTokens, 10)
    }
    const currentMilliseconds = performance.now() - currentStart
    database.connection.prepare = prepare
    const heads = queries.find(sql => sql.includes('SELECT seq FROM session_model_request_heads'))!
    const actor = queries.find(sql => sql.includes('FROM session_model_request_heads AS h'))!
    const usage = queries.find(sql => sql.includes('FROM session_model_usage_heads AS h'))!
    for (const [sql, bindings] of [[heads, [f.session]], [actor, [f.session, 'missing']], [usage, [f.session]]] as const) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map(row => String(row.detail)).join('\n')
      assert.doesNotMatch(plan, /SCAN |TEMP B-TREE/u)
      assert.match(plan, /SEARCH/u)
      if (sql === heads) assert.match(plan, /session_model_requests_latest/u)
      else assert.match(plan, /sqlite_autoindex_events_2 \(session_id=\? AND seq=\?\)/u)
    }
    assert.ok(queries.every(sql => !/GROUP BY|json_extract|kind='model.response'/u.test(sql)))
    assert.equal(database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
    const statement = prepare(`SELECT seq FROM session_model_request_heads WHERE session_id=? AND actor_key='actor-0' AND malformed=0`)
    statement.setReadBigInts(true)
    assert.equal(statement.get(f.session)!.seq, 12000n)
    t.diagnostic(JSON.stringify({ oldEvents: 144000, requests: 12000, actors: 40, failedResponses: 11999,
      migrationMs: Number(migrationMilliseconds.toFixed(2)), rounds: 20,
      oldActorAggregationsMs: Number(oldMilliseconds.toFixed(2)), headsActorAndSummaryReadsMs: Number(currentMilliseconds.toFixed(2)) }))
  } finally { database.close() }
  const reopened = new EdenDatabase(f.filename, 'mon')
  try {
    assert.equal(reopened.connection.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=130').get()!.n, 1)
    assert.deepEqual(new SessionRepository(reopened, 'mon').events.latestContextRequests(f.session).map(event => event.seq), expected)
  } finally { reopened.close() }
})

test('migration isolates malformed model records and keeps adjacent high sequence values exact', t => {
  const f = previousSchema(t), insert = f.connection.prepare('INSERT INTO events VALUES(?,?,NULL,?,?,?,0)')
  const high = 9_007_199_254_740_992n
  insert.run(randomUUID(), f.session, high, 'model.request', '{"actor":{"assistantID":7},"contextEstimate":{"generation":1}}')
  insert.run(randomUUID(), f.session, high + 1n, 'model.request', '{"actor":{"assistantID":"7"},"contextEstimate":{"generation":2}}')
  insert.run(randomUUID(), f.session, high + 2n, 'model.response', '{"usage":{"input":3,"output":4}}')
  const corrupt = randomUUID()
  f.connection.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(corrupt, 'Broken model', 'mon', 'active', 0, 0)
  insert.run(randomUUID(), corrupt, 1n, 'model.request', 'invalid request')
  insert.run(randomUUID(), corrupt, 2n, 'model.response', 'invalid response')
  f.connection.close()
  const database = new EdenDatabase(f.filename, 'mon')
  try {
    const sessions = new SessionRepository(database, 'mon')
    assert.deepEqual(sessions.events.latestActorContextEstimate(f.session, 7), { generation: 2 })
    assert.equal(sessions.events.latestContextRequests(f.session)[0]!.seq, String(high + 1n))
    assert.equal(sessions.read(f.session).contextTokens, 7)
    assert.throws(() => sessions.events.latestContextRequests(corrupt), /Malformed persisted model request JSON/)
    assert.throws(() => sessions.events.latestUsagePayload(corrupt), SyntaxError)
  } finally { database.close() }
})
