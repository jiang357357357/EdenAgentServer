import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { configureLogging, loggingFile } from '../../../src/modules/logging/index.ts'
import { faultFixture } from './fault-recovery-fixture.ts'

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await delay(20) }
  throw new Error('Runtime fixture did not reach the expected boundary')
}
async function logFixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-process-diagnostic-'))
  const options = { origin: 'local' as const, dataRoot: root, env: { EDEN_AGENT_LOG_DIR: path.join(root, 'logs'), EDEN_AGENT_LOG_FORMAT: 'json' } }
  const logger = configureLogging(options)
  t.after(async () => {
    logger.close()
    assert.equal(path.dirname(root), tmpdir())
    assert.ok(path.basename(root).startsWith('eden-process-diagnostic-'))
    await rm(root, { recursive: true, force: true })
  })
  return async () => (await readFile(loggingFile(options), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

test('worker crash preserves committed tool receipts, holds queued work and accepts a new turn without replay', { timeout: 40000 }, async t => {
  const logs = await logFixture(t)
  const f = await faultFixture(t, [{ tool: 'write_once', input: {} }, { wait: true }, { text: '新的回合已恢复' }])
  let writes = 0
  f.setTools([{ name: 'write_once', description: 'fixture', revision: '1', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return { committed: true } } }])
  const session = f.repository.create('Worker recovery')
  const first = f.sessions.start(session.id, '完成一次操作后等待'), queued = f.sessions.start(session.id, '不应自动重放')
  await waitFor(() => f.model.requests.length === 2)
  const started = (await logs()).find(record => record.event === 'runtime.process.started' && record.sessionId === session.id)!
  assert.ok(Number.isInteger(started.childPid))
  process.kill(Number(started.childPid), 'SIGKILL')
  await f.sessions.waitForIdle(session.id)
  assert.equal(f.input(first.inputId).state, 'interrupted'); assert.equal(f.input(queued.inputId).state, 'held')
  assert.equal(writes, 1); assert.equal(f.sessions.faultCount(), 0)
  const receipt = f.database.connection.prepare('SELECT state,result_json FROM tool_operations WHERE turn_id=?').get(first.turnId)!
  assert.equal(receipt.state, 'completed'); assert.match(String(receipt.result_json), /committed/)
  const failure = (await logs()).find(record => record.event === 'runtime.process.failed')!
  assert.equal(failure.childPid, started.childPid)
  assert.equal(failure.kind, 'crashed')
  assert.equal((failure.lastTool as { name: string }).name, 'write_once')
  assert.ok((failure.memory as { heapLimit: number }).heapLimit > 0)
  const next = f.sessions.start(session.id, '只处理这条新输入')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(next.inputId)
  assert.equal(f.model.requests.length, 3); assert.equal(writes, 1)
  assert.equal(f.input(queued.inputId).state, 'held')
})

test('forced user cancellation is cancelled rather than a failed turn and leaves an in-flight tool unknown', { timeout: 30000 }, async t => {
  const previous = process.env.EDEN_AGENT_RUNTIME_ABORT_TIMEOUT_MS
  process.env.EDEN_AGENT_RUNTIME_ABORT_TIMEOUT_MS = '100'
  t.after(() => { if (previous === undefined) delete process.env.EDEN_AGENT_RUNTIME_ABORT_TIMEOUT_MS; else process.env.EDEN_AGENT_RUNTIME_ABORT_TIMEOUT_MS = previous })
  const logs = await logFixture(t)
  const f = await faultFixture(t, [{ tool: 'uncooperative', input: {} }, { text: '后续请求可用' }])
  let entered = false, release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  t.after(release)
  f.setTools([{ name: 'uncooperative', description: 'fixture', revision: '1', parameters: { type: 'object', properties: {} },
    async execute() { entered = true; await pending; return { eventual: true } } }])
  const session = f.repository.create('Cancelled recovery'), first = f.sessions.start(session.id, '开始操作')
  await waitFor(() => entered)
  await f.sessions.cancel(session.id)
  await f.sessions.waitForIdle(session.id)
  assert.equal(f.input(first.inputId).state, 'cancelled')
  const turn = f.database.connection.prepare('SELECT state,error FROM turns WHERE id=?').get(first.turnId)!
  assert.equal(turn.state, 'cancelled'); assert.equal(turn.error, null)
  assert.equal(f.database.connection.prepare('SELECT state FROM tool_operations WHERE turn_id=?').get(first.turnId)?.state, 'unknown')
  const records = await logs()
  assert.ok(records.some(record => record.event === 'runtime.process.cancelled'))
  assert.equal(records.some(record => record.event === 'session.execution.failed'), false)
  release(); await delay(30)
  f.setTools([])
  const next = f.sessions.start(session.id, '只处理新的输入')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(next.inputId)
  assert.equal(f.sessions.faultCount(), 0)
})
