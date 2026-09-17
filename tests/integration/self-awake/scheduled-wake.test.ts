import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { selfAwakeRunInfoSchema } from '@eden/api'

test('run timer record comes from its own persisted jobs, including replacement state, not diary decisions', () => {
 const db = new EdenDatabase(':memory:', 'mon')
 try {
  const jobs = new JobRepository(db), sessions = new SessionRepository(db, 'mon'), session = sessions.create('wake'), repo = new SelfAwakeRepository(db)
  const create = (key: string, parent = '', target = session.id) => jobs.schedule({kind:'self_awake',sessionId:target,
    dueAt:Date.now()+60000,payload:{prompt:key},key,causationId:parent,depth:0})
  const parent=create('parent'), run=repo.begin(parent,{}, {})
  db.connection.prepare('UPDATE self_awake_runs SET decision_json=? WHERE id=?').run(JSON.stringify({next_wake:{after_minutes:1,reason:'not executed'}}),run)
  assert.equal(repo.read(run).scheduledWake,null)
  const first=create('first',parent.id), second=create('second',parent.id)
  create('other turn','another-parent')
  create('other session',parent.id,sessions.create('other').id)
  const result=selfAwakeRunInfoSchema.parse(repo.read(run)).scheduledWake!
  assert.equal(result.id,second.id)
  assert.equal(result.dueAt,second.dueAt)
  assert.equal(result.reason,'second')
  assert.equal(result.state,'cancelled')
  assert.notEqual(result.id,first.id)
 } finally {db.close()}
})
