import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-wake-status-'))
  const filename = path.join(root, 'test.sqlite'), stateFile = path.join(root, 'state.json')
  const db = new EdenDatabase(filename, 'mon'), sessions = new SessionRepository(db, 'mon')
  const session = sessions.create('isolated wake', [{ assistantId: 1 }])
  const jobs = new JobRepository(db, true), awake = new SelfAwakeRepository(db, stateFile, true)
  const directory = path.join(root, 'sessions', session.id)
  mkdirSync(directory, { recursive: true })
  t.after(() => {
    db.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })
  const external = (extra: Record<string, unknown> = {}) => writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    enabled: true, session_id: session.id,
    revision: Number(db.connection.prepare('SELECT revision FROM self_awake_session_schedules WHERE session_id=?').get(session.id)?.revision ?? 0),
    next_wake_at: new Date(Date.now() + 3600000).toISOString(), ...extra,
  }))
  const plan = () => jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: Date.now() - 1000,
    payload: {}, key: randomUUID(), causationId: '', depth: 0 })
  const retry = () => external({ consecutive_agent_failures: 5, last_error: 'Agent /internal/self-awake/run 通信失败 (kind=connect, system_code=10061)' })
  const schedule = () => awake.wakeSchedule(session.id)
  const dispatch = (job: ReturnType<typeof plan>) => {
    db.connection.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id)
    const run = awake.begin(job, {}, { assistantId: 1 })
    const inputs = new InputRepository(db, sessions.events)
    const input = inputs.enqueue(session.id, 'fixture only', randomUUID(), {})
    db.transaction(() => {
      awake.dispatchedInTransaction(run, input.inputId, input.turnId)
      jobs.completeInTransaction(job.id, input.inputId)
    })
    return { inputs, input, run }
  }
  return { db, filename, stateFile, sessions, session, jobs, awake, external, plan, retry, schedule, dispatch }
}

test('an overdue unclaimed job retains the scheduler retry time and actual transport failure across reopen', t => {
  const f = fixture(t), job = f.plan()
  f.retry()
  const before = f.schedule()!
  assert.equal(before.status, 'retrying')
  assert.ok(Date.parse(before.nextWakeAt!) > Date.now())
  assert.match(before.reason, /连续失败 5 次.*system_code=10061/)
  assert.equal(f.jobs.read(job.id).state, 'queued')
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM inputs').get()!.n, 0)
  const reopened = new EdenDatabase(f.filename, 'mon')
  try {
    assert.deepEqual(new SelfAwakeRepository(reopened, f.stateFile, true).wakeSchedule(f.session.id), before)
  } finally { reopened.close() }
})

test('a future external plan is not replaced by an old local due time', t => {
  const f = fixture(t)
  f.plan(); f.external()
  assert.equal(f.schedule()!.status, 'scheduled')
  assert.ok(Date.parse(f.schedule()!.nextWakeAt!) > Date.now())
})

test('accepted input and real execution take precedence over a stale scheduler retry', t => {
  const f = fixture(t), job = f.plan()
  f.retry()
  const { inputs } = f.dispatch(job)
  assert.equal(f.schedule()!.status, 'queued')
  assert.match(f.schedule()!.reason, /等待会话处理/)
  f.external({ revision: 0 })
  assert.equal(f.schedule()!.status, 'queued', 'an unconfirmed next plan must not hide already admitted input')
  inputs.claim(f.session.id)
  assert.equal(f.schedule()!.status, 'running')
  f.external({ session_id: randomUUID() })
  assert.equal(f.schedule()!.status, 'running', 'scheduler read failures must not erase actual execution facts')
})

test('an unknown execution blocks retry display without admitting or replaying another input', t => {
  const f = fixture(t), job = f.plan()
  f.retry()
  f.db.connection.prepare("UPDATE jobs SET state='unknown' WHERE id=?").run(job.id)
  assert.equal(f.schedule()!.status, 'blocked')
  assert.match(f.schedule()!.reason, /不会自动重放/)
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM inputs').get()!.n, 0)
})

test('an actual failed input is visible, and the next scheduler retry supersedes its terminal record', t => {
  const f = fixture(t), job = f.plan()
  f.external({ next_wake_at: new Date(Date.now() - 1000).toISOString() })
  const { inputs } = f.dispatch(job), input = inputs.claim(f.session.id)!
  inputs.finish(input, 'fixture interruption')
  f.jobs.settleInputs()
  f.external({ next_wake_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal(f.schedule()!.status, 'failed')
  f.retry()
  assert.equal(f.schedule()!.status, 'retrying')
})

test('pause and unacknowledged revisions remain distinct from transport retries', t => {
  const f = fixture(t)
  f.plan(); f.retry()
  f.awake.control.update(false, 0)
  assert.equal(f.schedule()!.status, 'disabled')
  f.awake.control.update(true, f.awake.control.read().updatedAt)
  f.db.connection.prepare(`INSERT INTO self_awake_session_schedules(session_id,job_id,revision,initial_anchor)
    VALUES(?,NULL,2,1) ON CONFLICT(session_id) DO UPDATE SET revision=2`).run(f.session.id)
  f.external({ revision: 1, consecutive_agent_failures: 5, last_error: 'old failure' })
  assert.equal(f.schedule()!.status, 'pending')
})

test('another session failure cannot replace this session retry or create any execution', t => {
  const f = fixture(t), other = f.sessions.create('peer')
  f.plan(); f.retry()
  const peer = f.jobs.schedule({ kind: 'self_awake', sessionId: other.id, dueAt: 1, payload: {},
    key: randomUUID(), causationId: '', depth: 0 })
  f.db.connection.prepare("UPDATE jobs SET state='unknown' WHERE id=?").run(peer.id)
  assert.equal(f.schedule()!.status, 'retrying')
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_runs').get()!.n, 0)
})
