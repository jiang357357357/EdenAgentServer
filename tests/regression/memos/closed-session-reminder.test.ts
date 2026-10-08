import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { memoCreateSchema } from '@eden/api'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { MemoRepository, MemoNotifications, MemoJobRecovery, memoDispatcher } from '../../../src/modules/memos/index.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'

function fixture(t: TestContext) {
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local'), sessions = new SessionService(repository, undefined)
  const jobs = new JobRepository(database), memos = new MemoRepository(database, jobs), notifications = new MemoNotifications(database)
  const session = repository.create('Reminder fixture')
  const memo = memos.create(memoCreateSchema.parse({ title: 'Due reminder', kind: 'reminder',
    remindAt: Date.now() - 1000, relatedSessionId: session.id }))
  const original = jobs.list({}).find(job => job.kind === 'memo.reminder')!
  const dispatch = memoDispatcher(database, memos, notifications, jobs, sessions)
  const recovery = new MemoJobRecovery(database, memos, notifications, jobs, sessions)
  t.after(async () => { await sessions.close(); database.close() })
  const closeSession = () => database.connection.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(session.id)
  return { database, repository, jobs, memos, notifications, session, memo, original, dispatch, recovery, closeSession }
}

test('an overdue reminder for a closed session creates one durable notification without reopening it', t => {
  const f = fixture(t)
  f.closeSession()
  const claimed = f.jobs.claim()!
  assert.equal(claimed?.id, f.original.id)
  f.dispatch(claimed)
  assert.equal(f.jobs.read(claimed.id).state, 'completed')
  assert.equal(f.jobs.read(claimed.id).inputId, null)
  assert.equal(f.notifications.list().length, 1)
  assert.equal(f.notifications.list()[0]!.readAt, null)
  assert.ok(f.memos.read(f.memo.id).lastTriggeredAt !== null)
  assert.equal(f.repository.read(f.session.id).status, 'closed')
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM inputs').get()?.n, 0)
  f.jobs.recover(); f.memos.recoverSchedules()
  assert.equal(f.jobs.claim(), undefined)
  assert.equal(f.notifications.list().length, 1)
})

test('recovery dispatches an existing overdue reminder even when its session was closed before restart', t => {
  const f = fixture(t)
  f.closeSession()
  f.jobs.recover(); f.memos.recoverSchedules()
  const claimed = f.jobs.claim()!
  assert.equal(claimed?.id, f.original.id)
  f.dispatch(claimed)
  assert.equal(f.notifications.list()[0]!.memo.id, f.memo.id)
  assert.equal(f.jobs.read(claimed.id).state, 'completed')
})

test('a closed session never resumes self-awake or other execution jobs while its reminder can notify', t => {
  const f = fixture(t)
  const other = f.jobs.schedule({ kind: 'plugin.hook', sessionId: f.session.id, dueAt: 1,
    payload: {}, key: 'closed-execution', causationId: '', depth: 0 })
  const awake = f.jobs.schedule({ kind: 'self_awake', sessionId: f.session.id, dueAt: 1,
    payload: {}, key: 'closed-awake', causationId: '', depth: 0 })
  f.closeSession()
  assert.equal(f.jobs.claim()?.id, f.original.id)
  assert.equal(f.jobs.claim(), undefined)
  assert.equal(f.jobs.read(other.id).state, 'queued')
  assert.equal(f.jobs.read(awake.id).state, 'cancelled')
})

test('explicit historical reminder redelivery can notify after the original session closes', t => {
  const f = fixture(t)
  const claimed = f.jobs.claim()!
  f.database.transaction(() => {
    f.notifications.recordInTransaction(claimed.id, f.memo)
    f.memos.deliveredInTransaction(f.memo.id, f.memo.updatedAt)
  })
  f.jobs.fail(claimed.id, 'Fixture dispatch failure')
  f.closeSession()
  const source = f.jobs.read(claimed.id)
  const replay = f.recovery.resubmit(source.id, source.updatedAt, 'Reviewed fixture evidence')
  assert.equal(replay.kind, 'memo.reminder.redelivery')
  assert.equal(f.jobs.claim()?.id, replay.id)
  f.recovery.dispatch(f.jobs.read(replay.id))
  assert.equal(f.jobs.read(replay.id).state, 'completed')
  assert.equal(f.notifications.list().length, 2)
  assert.equal(f.repository.read(f.session.id).status, 'closed')
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM inputs').get()?.n, 0)
})
