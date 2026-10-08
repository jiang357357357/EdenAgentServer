import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as yieldIo } from 'node:timers/promises'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'

const threadCpuUsage = (process as typeof process & {
  threadCpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage
}).threadCpuUsage

test('a thousand real session summaries yield between batches while preserving the synchronous list', async t => {
  const database = new EdenDatabase(':memory:', 'mon')
  t.after(() => database.close())
  const repository = new SessionRepository(database, 'mon')
  const seedStart = performance.now()
  for (let index = 0; index < 3000; index++) {
    const session = repository.create(`List fixture ${index}`, [{ assistantId: 1 }])
    database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(index, session.id)
  }
  const seedMs = Math.round(performance.now() - seedStart)
  let reads = 0
  const originalRead = repository.read.bind(repository)
  t.mock.method(repository, 'read', (id: string) => { reads++; return originalRead(id) })
  let selectionSql = ''
  const originalPrepare = database.connection.prepare.bind(database.connection)
  t.mock.method(database.connection, 'prepare', (sql: string) => {
    if (sql.startsWith('SELECT s.id FROM sessions s JOIN session_classification')) selectionSql = sql
    return originalPrepare(sql)
  })
  let baselineImmediateAt = -1
  const baselineImmediate = yieldIo().then(() => { baselineImmediateAt = reads })
  const beforeCpu = threadCpuUsage(), beforeStart = performance.now()
  const baseline = repository.list(5000, false, false)
  const baselineMs = performance.now() - beforeStart, baselineCpu = threadCpuUsage(beforeCpu)
  assert.equal(baseline.length, 1000, 'The existing 1000-session cap is preserved')
  assert.equal(baselineImmediateAt, -1)
  await baselineImmediate
  assert.equal(baselineImmediateAt, 1000)

  reads = 0
  let done = false
  const samples: number[] = []
  const observer = (async () => {
    while (!done) { await yieldIo(); samples.push(reads) }
  })()
  const afterCpu = threadCpuUsage(), afterStart = performance.now()
  let listed: Awaited<ReturnType<SessionRepository['listAsync']>>
  try { listed = await repository.listAsync(5000, false, false) }
  finally { done = true; await observer }
  const asyncMs = performance.now() - afterStart, asyncCpu = threadCpuUsage(afterCpu)
  assert.deepEqual(listed, baseline)
  assert.ok(samples.some(count => count > 0 && count < 1000), 'Other event-loop work runs after listing starts and before it completes')
  const intermediate = [0, ...samples, 1000]
  const maxReadGap = Math.max(...intermediate.slice(1).map((count, index) => count - intermediate[index]!))
  assert.ok(maxReadGap <= 25, 'No more than one 25-row batch may run without an event-loop opportunity')

  // The ID selection itself remains synchronous; expose its cost rather than hiding it behind yielding.
  assert.ok(selectionSql)
  const parameters = ['mon', 0, null, null, null, null, 1, 1000]
  const selectionStart = performance.now()
  const selected = originalPrepare(selectionSql).all(...parameters)
  const selectionMs = performance.now() - selectionStart
  const plan = originalPrepare('EXPLAIN QUERY PLAN ' + selectionSql).all(...parameters).map(row => String(row.detail))
  assert.equal(selected.length, 1000)
  assert.ok(plan.every(detail => !/\bevents\b/.test(detail)), 'ID selection does not scan the event history')
  t.diagnostic(JSON.stringify({ sessions: 3000, returnedSummaries: 1000, seedMs,
    baseline: { elapsedMs: Math.round(baselineMs), mainThreadCpuMs: Math.round((baselineCpu.user + baselineCpu.system) / 1000), eventLoopProgressBeforeCompletion: false },
    asynchronous: { elapsedMs: Math.round(asyncMs), mainThreadCpuMs: Math.round((asyncCpu.user + asyncCpu.system) / 1000),
      eventLoopSamples: samples.length, intermediateSamples: samples.filter(count => count > 0 && count < 1000).length, maxReadGap },
    idSelection: { elapsedMs: Number(selectionMs.toFixed(3)), plan,
      limitation: 'The original session-table filter/order query remains synchronous and may scan/sort more sessions; this change bounds summary batches, not that SQL cost.' } }))
})
