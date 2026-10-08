import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { once } from 'node:events'
import { createServer, get, Agent } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as yieldIo } from 'node:timers/promises'
import { EdenDatabase } from '@eden/store'
import { MonClient } from '@eden/integrations'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { MonSessionProjection, sessionProjectionKinds } from '../../../src/modules/mon/session-projection.ts'
import { MonSyncWorker } from '../../../src/modules/mon/sync-worker.ts'
import { healthHandler } from '../../../src/transport/http/health.ts'

const streamEvents = 1_000_000
const sessionCount = 160
const idleRounds = 3
const threadCpuUsage = (process as typeof process & {
  threadCpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage
}).threadCpuUsage

// Exact pre-fix query shapes: run against this same synthetic database, never checkout old code.
const legacySql = {
  metadata: "SELECT payload_json FROM events WHERE session_id=? AND kind IN ('session.created','session.metadata.updated') ORDER BY seq DESC LIMIT 1",
  title: "SELECT kind,payload_json FROM events WHERE session_id=? AND kind IN ('session.title_updated','session.renamed') ORDER BY seq DESC LIMIT 1",
  semanticTime: 'SELECT created_at FROM events WHERE session_id=? AND kind IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT 1',
  projection: 'SELECT * FROM events WHERE session_id=? AND seq>? AND seq<=? AND kind IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT ?',
}

async function seed(database: EdenDatabase, hot: string[]) {
  const insert = database.connection.prepare(`WITH RECURSIVE numbers(n) AS
    (VALUES(?) UNION ALL SELECT n+1 FROM numbers WHERE n<?)
    INSERT INTO events(id,session_id,turn_id,seq,kind,payload_json,created_at)
    SELECT printf('00000000-0000-4000-8000-%012d',n+?),?,NULL,n+?,'agent.message_update','{}',n+1 FROM numbers`)
  for (const [index, sessionId] of hot.entries()) {
    const base = Number(database.connection.prepare('SELECT MAX(seq) AS seq FROM events WHERE session_id=?').get(sessionId)!.seq)
    for (let offset = 1; offset <= streamEvents / hot.length; offset += 10_000) {
      database.transaction(() => insert.run(offset, Math.min(offset + 9_999, streamEvents / hot.length),
        index * streamEvents / hot.length, sessionId, base))
      await yieldIo()
    }
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-mon-idle-million-'))
  const database = new EdenDatabase(path.join(root, 'synthetic.sqlite'), 'mon')
  const sessions = new SessionRepository(database, 'mon')
  const connections = new MonConnectionRepository(database)
  const worker = new MonSyncWorker(sessions, connections, new MonSessionProjection(sessions))
  const httpAgent = new Agent({ keepAlive: true, maxSockets: 1 })
  let activePhase = ''
  const handled = new Map<string, number>()
  const handler = healthHandler('mon', () => ({ model: false, sessionFaults: 0, memoryExtraction: true }))
  const server = createServer((request, response) => {
    if (activePhase) handled.set(activePhase, (handled.get(activePhase) ?? 0) + 1)
    handler(request, response)
  })
  // Seeding deliberately takes longer than Node's default keep-alive idle timeout.
  server.keepAliveTimeout = 180_000
  t.after(async () => {
    await worker.close()
    httpAgent.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    database.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const health = () => new Promise<number>((resolve, reject) => {
    const start = performance.now()
    const request = get({ host: '127.0.0.1', port, path: '/healthz', agent: httpAgent }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200)
          assert.equal(JSON.parse(body).status, 'ok')
          resolve(performance.now() - start)
        } catch (error) { reject(error) }
      })
      response.on('error', reject)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('Temporary health request timed out')))
    request.on('error', reject)
  })
  // Only outgoing MonCore projection is simulated; HTTP health and all SQLite reads are real.
  t.mock.method(MonClient.prototype, 'post', async () => ({ id: 17 }))
  t.mock.method(MonClient.prototype, 'put', async () => ({}))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External network is forbidden in this fixture') })
  const ids: string[] = []
  for (let index = 0; index < sessionCount; index++) {
    const session = sessions.create('', [{ assistantId: 5 }])
    database.transaction(() => connections.saveInTransaction(session.id,
      { coreBaseUrl: 'http://127.0.0.1:1', coreToken: 'synthetic-idle-fixture-only' }))
    ids.push(session.id)
  }
  sessions.setMetadata(ids[0]!, [{ assistantId: 7 }], { fixture: 'early metadata' })
  sessions.rename(ids[0]!, 'Early title')
  await health() // Establish one reusable socket before measuring event-loop availability.
  const measure = async (name: string, work: () => Promise<void> | void) => {
    activePhase = name
    const response = health()
    void response.catch(() => {})
    const cpu = threadCpuUsage(), start = performance.now()
    try { await work() } finally { activePhase = '' }
    const elapsedMs = performance.now() - start, used = threadCpuUsage(cpu)
    const healthMs = await response
    return { name, elapsedMs: Math.round(elapsedMs), mainThreadCpuMs: Math.round((used.user + used.system) / 1000),
      healthMs: Math.round(healthMs), healthHandledDuringPass: handled.get(name) ?? 0 }
  }
  return { database, sessions, worker, ids, measure }
}

function legacyBaseline(f: Awaited<ReturnType<typeof fixture>>) {
  const db = f.database.connection
  for (let round = 0; round < idleRounds; round++) {
    for (const [index, id] of f.ids.slice(0, 2).entries()) {
      const metadata = db.prepare(legacySql.metadata).get(id)!
      assert.equal(JSON.parse(String(metadata.payload_json)).participants[0].assistantId, index ? 5 : 7)
      const title = db.prepare(legacySql.title).get(id)
      assert.equal(title?.kind, index ? undefined : 'session.title_updated')
    }
  }
}

function queryPlans(f: Awaited<ReturnType<typeof fixture>>) {
  const db = f.database.connection, id = f.ids[0]!
  const kinds = JSON.stringify(sessionProjectionKinds)
  return Object.fromEntries(Object.entries(legacySql).map(([name, sql]) => {
    const parameters = name === 'semanticTime' ? [id, kinds]
      : name === 'projection' ? [id, 0, streamEvents, kinds, 100] : [id]
    const details = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => String(row.detail))
    return [name, details]
  }))
}

test('one million sparse events keep zero-client Mon idle scans shallow and real HTTP responsive without statistics',
  { timeout: 180_000 }, async t => {
    const f = await fixture(t)
    const db = f.database.connection
    const seedStart = performance.now()
    await seed(f.database, f.ids.slice(0, 2))
    const totalBefore = Number(db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count)
    assert.equal(totalBefore, streamEvents + sessionCount + 2)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_stat1'").get(), undefined,
      'The regression must cover an un-analyzed legacy database')
    const seedMs = Math.round(performance.now() - seedStart)
    const plansBefore = queryPlans(f)
    const baseline = await f.measure('legacy metadata/title SQL: three idle rounds, two hot sessions', () => legacyBaseline(f))
    assert.equal(baseline.healthHandledDuringPass, 0, 'Synchronous legacy scans cannot service the queued HTTP request')

    const statements = new Set<string>()
    const originalPrepare = db.prepare.bind(db)
    t.mock.method(db, 'prepare', (sql: string) => { statements.add(sql); return originalPrepare(sql) })
    const reads = t.mock.method(f.sessions, 'read')
    const metadataReads = t.mock.method(f.sessions, 'readMetadata')
    const batches = t.mock.method(f.sessions.events, 'projectionBatch')
    const clear = () => { reads.mock.resetCalls(); metadataReads.mock.resetCalls(); batches.mock.resetCalls() }

    assert.equal(f.sessions.read(f.ids[0]!).titleSource, 'user')
    assert.deepEqual(f.sessions.readMetadata(f.ids[0]!).environment, { fixture: 'early metadata' })
    assert.equal(f.sessions.read(f.ids[1]!).titleSource, 'pending')
    assert.equal(f.sessions.readMetadata(f.ids[1]!).metadataSeq, '1')
    const priming = await f.measure('initial semantic projection', () => f.worker.syncPending())
    assert.ok(priming.healthHandledDuringPass > 0, 'Health must run before the real synchronization pass ends')
    const progress = db.prepare('SELECT session_id,after_seq,error FROM mon_sync_progress').all()
    assert.equal(progress.length, sessionCount)
    for (const row of progress) {
      const expected = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE session_id=?').get(String(row.session_id))!.seq
      assert.equal(String(row.after_seq), String(expected))
      assert.equal(row.error, null)
    }

    clear()
    const idle = []
    for (let round = 0; round < idleRounds; round++) {
      const result = await f.measure(`idle ${round + 1}`, () => f.worker.syncPending())
      assert.ok(result.healthHandledDuringPass > 0, 'Even entirely idle passes must yield to HTTP')
      idle.push(result)
    }
    assert.equal(reads.mock.callCount(), 0, 'Idle discovery must not reconstruct complete session summaries')
    assert.equal(metadataReads.mock.callCount(), 0, 'Idle discovery must not decode metadata again')
    assert.equal(batches.mock.callCount(), 0, 'No new sequence means no projection batch query')

    const appended = f.sessions.events.append(f.ids[0]!, null, 'agent.message_update', {})
    clear()
    const streamOnly = await f.measure('one new non-semantic stream event', () => f.worker.syncPending())
    assert.ok(streamOnly.healthHandledDuringPass > 0)
    assert.equal(reads.mock.callCount(), 0)
    assert.equal(metadataReads.mock.callCount(), 0, 'A stream-only advance must not reconstruct metadata')
    assert.equal(batches.mock.callCount(), 1)
    assert.equal(db.prepare('SELECT after_seq FROM mon_sync_progress WHERE session_id=?').get(f.ids[0]!)!.after_seq, appended.seq)

    const kindQueries = [...statements].filter(sql => /FROM events\s+WHERE session_id=\?\s+AND kind=\?/i.test(sql))
    assert.ok(kindQueries.length, 'Real repository reads must seek a specific kind before sorting sequences')
    const fixedPlans = kindQueries.map(sql => ({ sql, plan: originalPrepare('EXPLAIN QUERY PLAN ' + sql)
      .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0)).map(row => String(row.detail)) }))
    for (const item of fixedPlans) assert.ok(item.plan.some(detail => /SEARCH.*events_session_kind_seq.*session_id=\? AND kind=\?/.test(detail)))
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_stat1'").get(), undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count, totalBefore + 1,
      'Performance repair must preserve every historical event')
    t.diagnostic(JSON.stringify({ syntheticStreamEvents: streamEvents, totalEvents: totalBefore + 1, connectedSessions: sessionCount,
      websocketClients: 0, sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get()!.version,
      statistics: 'absent', seedMs, baseline, legacyPlans: plansBefore, priming, idle, streamOnly, fixedPlans,
      idleDeepReads: 0, streamOnlyMetadataReads: 0,
      fixedHealthMaxMs: Math.max(priming.healthMs, streamOnly.healthMs, ...idle.map(value => value.healthMs)) }))
  })
