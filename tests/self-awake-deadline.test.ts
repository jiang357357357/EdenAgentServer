import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { selfAwakeDecisionSchema } from '@eden/api'
import { wakeDeadline, wakeIntervalMs } from '../src/modules/self-awake/deadline.ts'
import { SelfAwakeRepository } from '../src/modules/self-awake/repository.ts'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../src/modules/jobs/repository.ts'

const decision = { mood: '', current_desire: '', observations: [], should_interrupt_user: false, action: 'write_diary', action_payload: {}, next_wake: null, diary: { title: 'null plan', content: 'Use the watchdog' } }
test('null suggestion completes and persists the diary without weakening other fields', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const sessions = new SessionRepository(db, 'mon'), jobs = new JobRepository(db), awake = new SelfAwakeRepository(db)
    const session = sessions.create('fixture')
    const job = jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: 1, payload: {}, key: 'test', causationId: '', depth: 0 })
    const id = awake.begin(job, {}, {})
    db.connection.prepare("UPDATE self_awake_runs SET state='running' WHERE id=?").run(id)
    awake.finish(id, selfAwakeDecisionSchema.parse(decision))
    assert.equal(awake.read(id).status, 'completed')
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM self_awake_diaries WHERE run_id=?').get(id)?.n, 1)
    assert.equal(JSON.parse(String(db.connection.prepare('SELECT decision_json FROM self_awake_runs WHERE id=?').get(id)?.decision_json)).next_wake, null)
    assert.equal(selfAwakeDecisionSchema.safeParse({ ...decision, next_wake: { after_minutes: -1, reason: 'bad' } }).success, false)
  } finally { db.close() }
})
test('initial deadline survives another repository and repeated timer calls without moving', () => {
  const db = new EdenDatabase(':memory:', 'local')
  try {
    const initial = 1_800_000_000_000
    assert.equal(wakeDeadline(db, undefined, initial), initial + wakeIntervalMs)
    assert.equal(new SelfAwakeRepository(db).deadline(initial + 13 * 3600000), initial + wakeIntervalMs)
  } finally { db.close() }
})

test('three-day meeting reminder is neither shortened nor replaced by self-awake plans', async () => {
  const { MemoRepository } = await import('../src/modules/memos/repository.ts')
  const db = new EdenDatabase(':memory:', 'local')
  try {
    const jobs = new JobRepository(db), memos = new MemoRepository(db, jobs), sessions = new SessionRepository(db, 'local')
    const session = sessions.create('meeting'), dueAt = Date.now() + 3 * 86400000
    const memo = memos.create({ title: 'Three-day meeting', remindAt: dueAt, relatedSessionId: session.id } as never)
    const original = jobs.list({}).find(job => job.kind === 'memo.reminder')!
    const deadline = wakeDeadline(db)
    for (const key of ['one', 'two']) jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: deadline, payload: {}, key, causationId: '', depth: 0 })
    jobs.recover()
    memos.recoverSchedules()
    assert.equal(memos.read(memo.id).remindAt, dueAt)
    assert.equal(jobs.read(original.id).dueAt, dueAt)
    assert.equal(jobs.read(original.id).state, 'queued')
    assert.equal(jobs.list({ state: 'queued' }).filter(job => job.kind === 'memo.reminder').length, 1)
    const wake = jobs.claim(deadline)!
    assert.equal(wake.kind, 'self_awake')
    jobs.fail(wake.id, 'fixture finished')
    assert.equal(jobs.claim(deadline + 1), undefined)
    assert.equal(jobs.claim(dueAt)?.id, original.id)
  } finally { db.close() }
})
