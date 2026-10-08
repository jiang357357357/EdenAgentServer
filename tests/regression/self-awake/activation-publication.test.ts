import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EdenDatabase } from '@eden/store'
import { migrations } from '@eden/store/testing'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { publishWakeActivation } from '../../../src/modules/self-awake/activation-publication.ts'
import { SelfAwakeTimerPublication } from '../../../src/modules/self-awake/timer-publication.ts'

const legacyQuery = `SELECT r.id,MIN(e.created_at) AS started_at,r.state,r.completed_at FROM self_awake_runs r
  JOIN events e ON e.session_id=r.session_id AND e.turn_id=r.turn_id
  WHERE e.kind='agent.agent_start' GROUP BY r.id ORDER BY started_at DESC LIMIT 1`

const selfAwakeActivationSchema = migrations[128]!

function populate(db: DatabaseSync, from: number, count: number) {
  db.prepare("INSERT OR IGNORE INTO sessions VALUES('session','','mon','active',0,0)").run()
  const job = db.prepare(`INSERT INTO jobs(id,kind,session_id,due_at,payload_json,operation_key,causation_id,depth,state,attempts,created_at,updated_at)
    VALUES(?,'self_awake','session',0,'{}',?,'',0,'completed',1,0,0)`)
  const run = db.prepare(`INSERT INTO self_awake_runs(id,job_id,session_id,turn_id,event_id,state,request_json,author_json,attempts,started_at,created_at,updated_at)
    VALUES(?,?,'session',?,'','completed','{}','{}',1,0,0,0)`)
  const event = db.prepare("INSERT INTO events VALUES(?,'session',?,?,?,'{}',?)")
  db.exec('BEGIN')
  try {
    for (let i = from; i < from + count; i++) {
      const id = `run-${i}`, turn = `turn-${i}`
      job.run(id, id); run.run(id, id, turn)
      for (let n = 0; n < 3; n++) event.run(`${id}-event-${n}`, turn, i * 3 + n + 1, n === 0 ? 'agent.agent_start' : 'agent.message_update', i * 10 + n)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-activation-projection-'))
  const db = new EdenDatabase(':memory:', 'mon')
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const state = path.join(root, 'state.json'), output = path.join(root, 'agent_activation.json')
  writeFileSync(state, '{"scheduler":"unchanged"}')
  return { root, db, state, output, read: () => JSON.parse(readFileSync(output, 'utf8')) as { run_id: string; started_at: string; completed_at: string | null } }
}

test('indexed publication preserves actual start, live completion, fallback and cleared-history state', t => {
  const f = fixture(t)
  populate(f.db.connection, 0, 2)
  f.db.connection.prepare("UPDATE self_awake_runs SET state='running',completed_at=500,started_at=999999 WHERE id='run-1'").run()
  publishWakeActivation(f.db, f.state)
  assert.deepEqual(f.read(), { run_id: 'run-1', started_at: new Date(10).toISOString(), completed_at: null })
  f.db.connection.prepare("UPDATE self_awake_runs SET state='completed' WHERE id='run-1'").run()
  publishWakeActivation(f.db, f.state)
  assert.equal(f.read().completed_at, new Date(500).toISOString())
  f.db.connection.prepare("DELETE FROM self_awake_runs WHERE id='run-1'").run()
  publishWakeActivation(f.db, f.state)
  assert.equal(f.read().run_id, 'run-0')
  assert.equal(new SelfAwakeRepository(f.db).clearHistory().deleted, 1)
  publishWakeActivation(f.db, f.state)
  assert.equal(existsSync(f.output), false)
  assert.equal(readFileSync(f.state, 'utf8'), '{"scheduler":"unchanged"}')
})

test('unchanged publications perform two bounded reads without rewriting output or database', t => {
  const f = fixture(t)
  populate(f.db.connection, 0, 100)
  publishWakeActivation(f.db, f.state)
  utimesSync(f.output, new Date(1000), new Date(1000))
  const mtime = statSync(f.output).mtimeMs
  const changes = f.db.connection.prepare('SELECT total_changes() AS n').get()!.n
  const queries: string[] = [], prepare = f.db.connection.prepare.bind(f.db.connection)
  const spy = t.mock.method(f.db.connection, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql) })
  for (let i = 0; i < 5; i++) publishWakeActivation(f.db, f.state)
  spy.mock.restore()
  assert.equal(queries.length, 10)
  assert.ok(queries.every(sql => !/\bevents\b|GROUP BY|MIN\(/i.test(sql)))
  const latestPlan = prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all().map(row => String(row.detail)).join('\n')
  const runPlan = prepare(`EXPLAIN QUERY PLAN ${queries[1]}`).all('run-99').map(row => String(row.detail)).join('\n')
  assert.match(latestPlan, /COVERING INDEX self_awake_activations_legacy/)
  assert.doesNotMatch(latestPlan, /TEMP B-TREE/)
  assert.match(runPlan, /SEARCH self_awake_runs USING INDEX sqlite_autoindex_self_awake_runs_1/)
  assert.equal(statSync(f.output).mtimeMs, mtime)
  assert.equal(prepare('SELECT total_changes() AS n').get()!.n, changes)
})

test('publication failure keeps durable facts and timer retries without duplicate state', t => {
  const f = fixture(t)
  populate(f.db.connection, 0, 1)
  const publication = new SelfAwakeTimerPublication(f.db, f.state)
  mkdirSync(f.output)
  publication.publish() // Legacy output failure is reported without blocking other session publications.
  assert.ok(publication.fault)
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_activations').get()!.n, 1)
  rmSync(f.output, { recursive: true })
  publication.publish()
  assert.equal(publication.fault, undefined)
  assert.equal(f.read().run_id, 'run-0')
  publication.publish()
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_activations').get()!.n, 1)
})

test('twenty thousand historical runs migrate once and reopen with bounded publication queries', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-activation-upgrade-'))
  const filename = path.join(root, 'temporary.db'), state = path.join(root, 'state.json')
  let legacy: DatabaseSync | undefined = new DatabaseSync(filename)
  let current: EdenDatabase | undefined
  t.after(() => { legacy?.close(); current?.close(); rmSync(root, { recursive: true, force: true }) })
  const target = migrations.indexOf(selfAwakeActivationSchema)
  assert.ok(target > 0)
  legacy.exec('PRAGMA foreign_keys=ON')
  for (let i = 0; i < target; i++) {
    legacy.exec(migrations[i]!)
    legacy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(i + 1, 1)
  }
  legacy.exec(`PRAGMA user_version=${target}`)
  legacy.prepare("INSERT INTO realm_meta VALUES('origin','mon')").run()
  populate(legacy, 0, 100)
  const smallMedian = medianQueryTime(legacy, legacyQuery)
  populate(legacy, 100, 19900)
  const baselineMedian = medianQueryTime(legacy, legacyQuery)
  assert.match(legacy.prepare(`EXPLAIN QUERY PLAN ${legacyQuery}`).all().map(row => row.detail).join('\n'), /TEMP B-TREE/)
  legacy.close(); legacy = undefined
  const migrationStart = performance.now()
  current = new EdenDatabase(filename, 'mon')
  const migrationMs = performance.now() - migrationStart
  assert.equal(current.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_activations').get()!.n, 20000)
  publishWakeActivation(current, state)
  const output = path.join(root, 'agent_activation.json'), published = readFileSync(output, 'utf8')
  assert.equal(JSON.parse(published).run_id, 'run-19999')
  const queries: string[] = [], prepare = current.connection.prepare.bind(current.connection)
  const spy = t.mock.method(current.connection, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql) })
  publishWakeActivation(current, state)
  spy.mock.restore()
  const indexedMedian = medianQueryTime(current.connection, queries[0]!)
  current.close(); current = undefined
  const reopenStart = performance.now()
  current = new EdenDatabase(filename, 'mon')
  const reopenMs = performance.now() - reopenStart
  publishWakeActivation(current, state)
  assert.equal(readFileSync(output, 'utf8'), published)
  assert.equal(current.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_activations').get()!.n, 20000)
  t.diagnostic(JSON.stringify({ runs: 20000, events: 60000, old100MedianMs: smallMedian,
    old20000MedianMs: baselineMedian, indexed20000MedianMs: indexedMedian, migrationMs, reopenMs }))
})

function medianQueryTime(db: DatabaseSync, sql: string): number {
  const statement = db.prepare(sql), times: number[] = []
  for (let i = 0; i < 8; i++) {
    const start = performance.now(); statement.get()
    if (i > 0) times.push(performance.now() - start)
  }
  return times.sort((a, b) => a - b)[3]!
}
