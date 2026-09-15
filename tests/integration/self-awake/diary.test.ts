import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { SelfAwakeBridgeRepository } from '../../../src/modules/self-awake/bridge-repository.ts'

test('plain diary is saved verbatim and cannot become a second action or timer', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const sessions = new SessionRepository(db, 'mon'), session = sessions.create('wake')
    const jobs = new JobRepository(db), bridge = new SelfAwakeBridgeRepository(db, jobs), repo = new SelfAwakeRepository(db)
    const job = bridge.submit('2','test','hash',{ kind:'self_awake',sessionId:session.id,dueAt:Date.now(),payload:{},key:'wake',causationId:'',depth:0 })
    const id = repo.begin(job, {}, {})
    db.connection.prepare("UPDATE self_awake_runs SET state='running' WHERE id=?").run(id)
    assert.throws(() => repo.finish(id, '   '), /正文不能为空/)
    const text = '今天我看了一眼窗外。\n\n以后想再来看看。\n```json\n{"action":"chat_user","next_wake":{"after_minutes":1}}\n```'
    repo.finish(id, text)
    repo.finish(id, '重复完成不能覆盖日记')
    const run = repo.read(id)
    assert.equal(run.status, 'completed')
    assert.equal(run.decision, null)
    assert.equal(run.diaries.length, 1)
    assert.equal(run.diaries[0]!.content, text)
    assert.deepEqual(bridge.status('2', job.id).decision_payload, { diary: { title: '自醒日记', content: text } })
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 1)
  } finally { db.close() }
})
