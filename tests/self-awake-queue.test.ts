import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../src/modules/jobs/repository.ts'
import { SelfAwakeBridgeRepository } from '../src/modules/self-awake/bridge-repository.ts'

function fixture(context: test.TestContext, external = false) {
  const db = new EdenDatabase(':memory:', 'mon')
  context.after(() => db.close())
  const jobs = new JobRepository(db, external), sessions = new SessionRepository(db, 'mon')
  const session = sessions.create('wake')
  const plan = (key: string, scheduler?: string) => ({ kind: 'self_awake', sessionId: session.id, dueAt: 1,
    payload: scheduler ? { scheduler } : {}, key, causationId: '', depth: 0 })
  return { db, jobs, sessions, session, plan }
}

test('new wake replaces the pending wake across sessions; idempotent old replay cannot resurrect it', context => {
  const f = fixture(context)
  const first = f.jobs.schedule(f.plan('first'))
  const next = f.jobs.schedule({ ...f.plan('next'), sessionId: f.sessions.create('other').id })
  assert.equal(f.jobs.read(first.id).state, 'cancelled')
  assert.equal(f.jobs.schedule(f.plan('first')).state, 'cancelled')
  assert.equal(f.jobs.list({ state: 'queued' }).length, 1)
  assert.equal(f.jobs.list({ state: 'queued' })[0]!.id, next.id)
  assert.ok(next.createdAt > first.createdAt)
  assert.throws(() => f.db.connection.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(first.id), /UNIQUE/)
})

test('only one wake executes; the next plan waits while unrelated jobs may proceed', context => {
  const f = fixture(context)
  const active = f.jobs.schedule(f.plan('first'))
  assert.equal(f.jobs.claim()?.id, active.id)
  const next = f.jobs.schedule(f.plan('next'))
  assert.equal(f.jobs.claim(), undefined)
  const unrelated = f.jobs.schedule({ ...f.plan('memo'), kind: 'memo.reminder' })
  assert.equal(f.jobs.claim()?.id, unrelated.id)
  f.jobs.fail(active.id, 'ended')
  assert.equal(f.jobs.claim()?.id, next.id)
})

test('interrupted dispatch and deferral cannot recreate a superseded pending plan', context => {
  const f = fixture(context)
  const first = f.jobs.schedule(f.plan('first'))
  f.jobs.claim()
  const next = f.jobs.schedule(f.plan('next'))
  f.jobs.defer(first.id, 'waiting')
  assert.equal(f.jobs.read(first.id).state, 'cancelled')
  f.jobs.claim()
  const latest = f.jobs.schedule(f.plan('latest'))
  f.jobs.recover()
  assert.equal(f.jobs.read(next.id).state, 'cancelled')
  assert.equal(f.jobs.read(latest.id).state, 'queued')
})

test('external ownership prevents local timer execution and duplicate external triggers join one job', context => {
  const f = fixture(context, true), bridge = new SelfAwakeBridgeRepository(f.db, f.jobs)
  const local = f.jobs.schedule(f.plan('local'))
  assert.equal(f.jobs.claim(), undefined)
  const external = bridge.submit('user', 'external', 'hash', f.plan('external', 'monos'))
  assert.equal(f.jobs.read(local.id).state, 'cancelled')
  assert.equal(f.jobs.claim()?.id, external.id)
  assert.equal(bridge.coalesce('user', 'duplicate', 'hash2')?.id, external.id)
  assert.equal(bridge.existing('user', 'duplicate', 'hash2')?.id, external.id)
  assert.throws(() => bridge.existing('user', 'duplicate', 'changed'), /different request/)
  assert.equal(bridge.coalesce('another-user', 'other', 'hash'), undefined)
  assert.equal(f.jobs.list({ state: 'queued' }).length, 0)
})

test('pending external action keeps the execution slot until the action finishes', context => {
  const f = fixture(context)
  const active = f.jobs.schedule(f.plan('first'))
  f.jobs.claim()
  f.db.transaction(() => f.jobs.completeInTransaction(active.id))
  f.db.connection.prepare("INSERT INTO self_awake_runs(id,job_id,session_id,event_id,state,request_json,author_json,attempts,created_at,updated_at) VALUES('run',?,?, '', 'awaiting_action','{}','{}',1,0,0)").run(active.id, f.session.id)
  const next = f.jobs.schedule(f.plan('next'))
  assert.equal(f.jobs.claim(), undefined)
  f.db.connection.prepare("UPDATE self_awake_runs SET state='completed' WHERE id='run'").run()
  assert.equal(f.jobs.claim()?.id, next.id)
})
