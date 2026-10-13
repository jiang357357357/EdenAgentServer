import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { runSearchProcess } from '../../../src/modules/workspace/workspace-search-process.ts'
import { SEARCH_BUDGET_MS, SEARCH_CLEANUP_MS } from '../../../src/modules/workspace/workspace-search-contracts.ts'

async function workerFixture(body: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-search-deadline-'))
  const worker = path.join(root, 'worker.mjs')
  await writeFile(worker, `import {writeFileSync} from 'node:fs';
    process.once('message', request => {
      writeFileSync(request.root + '/pid.txt', String(process.pid));
      ${body}
    });`)
  return { root, worker: pathToFileURL(worker),
    request: { root, requested: '.', query: 'needle', limit: 20 },
    async close() {
      assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
      await rm(root, { recursive: true, force: true })
    } }
}

function assertExited(pid: number) {
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH')
}

const progress = `process.send({type:'progress', snapshot:{matches:[{path:'found.txt',line:2,preview:'needle'}],
  scannedFiles:4, visitedEntries:7, skippedFiles:1}});`

test('search default budget is two minutes, with at most one second for worker cleanup', () => {
  assert.equal(SEARCH_BUDGET_MS, 120_000)
  assert.equal(SEARCH_CLEANUP_MS, 1_000)
})

test('stalled read worker returns partial results at the host deadline and really exits', async () => {
  const fixture = await workerFixture(`${progress} setInterval(() => {}, 1000);`)
  try {
    const started = performance.now()
    const result = await runSearchProcess(fixture.request, new AbortController().signal, { budgetMs: 800, worker: fixture.worker })
    assert.equal(result.stopReason, 'timeout')
    assert.equal(result.truncated, true)
    assert.equal(result.budgetMs, 800)
    assert.equal(result.workerStopped, true)
    assert.equal(result.scannedFiles, 4)
    assert.equal(result.visitedEntries, 7)
    assert.equal(result.skippedFiles, 1)
    assert.deepEqual(result.matches, [{ path: 'found.txt', line: 2, preview: 'needle' }])
    assert.ok(result.elapsedMs >= 790)
    assert.ok(performance.now() - started < 2800)
    assertExited(Number(await readFile(path.join(fixture.root, 'pid.txt'), 'utf8')))
  } finally { await fixture.close() }
})

test('cancellation wakes a stalled worker immediately and preserves the original abort reason', async () => {
  const fixture = await workerFixture(`${progress} setInterval(() => {}, 1000);`)
  const controller = new AbortController()
  const reason = new Error('user cancelled search')
  try {
    const result = runSearchProcess(fixture.request, controller.signal, { worker: fixture.worker })
    // Attach a rejection handler before aborting, including under --unhandled-rejections=strict.
    const cancelled = assert.rejects(result, error => error === reason)
    let pid = 0
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await readFile(path.join(fixture.root, 'pid.txt'), 'utf8').catch(() => '0'))
      if (!pid) await delay(20)
    }
    assert.ok(pid, 'worker must have started before cancellation')
    const started = performance.now()
    controller.abort(reason)
    await cancelled
    assert.ok(performance.now() - started < 1500)
    assertExited(pid)
  } finally { controller.abort(reason); await fixture.close() }
})

test('an unresponsive worker without progress still returns an honest timeout', async () => {
  const fixture = await workerFixture('setInterval(() => {}, 1000);')
  try {
    const result = await runSearchProcess(fixture.request, new AbortController().signal, { budgetMs: 500, worker: fixture.worker })
    assert.equal(result.stopReason, 'timeout')
    assert.equal(result.truncated, true)
    assert.deepEqual(result.matches, [])
    assert.equal(result.scannedFiles, 0)
    assert.equal(result.workerStopped, true)
  } finally { await fixture.close() }
})

test('worker crash and invalid IPC fail explicitly instead of becoming a successful empty search', async t => {
  for (const [name, body, expected] of [
    ['crash', 'process.exit(2)', /exited before returning/],
    ['malformed', "process.send({type:'progress', snapshot:{matches:[],scannedFiles:-1}}); setInterval(() => {},1000);", /Invalid search worker response/],
    ['reported error', "process.send({type:'error',error:'permission denied'});", /permission denied/],
  ] as const) {
    await t.test(name, async () => {
      const fixture = await workerFixture(body)
      try {
        await assert.rejects(runSearchProcess(fixture.request, new AbortController().signal, { worker: fixture.worker }), expected)
        assertExited(Number(await readFile(path.join(fixture.root, 'pid.txt'), 'utf8')))
      } finally { await fixture.close() }
    })
  }
})

test('model/host requests cannot increase the search budget past two minutes', () => {
  const request = { root: tmpdir(), requested: '.', query: 'x', limit: 20 }
  for (const budgetMs of [0, -1, NaN, Infinity, 120_001]) {
    assert.throws(() => runSearchProcess(request, new AbortController().signal, { budgetMs }), /Invalid search budget/)
  }
})
