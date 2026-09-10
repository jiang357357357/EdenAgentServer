import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../src/modules/jobs/repository.ts'
import { SelfAwakeRepository } from '../src/modules/self-awake/repository.ts'

test('execution review omits accumulated streaming snapshots and retains tool evidence', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const sessions = new SessionRepository(db, 'mon'), session = sessions.create('wake')
    const jobs = new JobRepository(db), repository = new SelfAwakeRepository(db)
    const job = jobs.schedule({ kind:'self_awake',sessionId:session.id,dueAt:Date.now(),payload:{},key:'wake',causationId:'',depth:0 })
    const runId = repository.begin(job, {}, {})
    db.connection.prepare('UPDATE self_awake_runs SET turn_id=? WHERE id=?').run('00000000-0000-4000-8000-000000000001', runId)
    db.transaction(() => {
      for (let i=0;i<1600;i++) sessions.events.insert(session.id,'00000000-0000-4000-8000-000000000001','agent.message_update',{text:'x'.repeat(4000)})
      sessions.events.insert(session.id,'00000000-0000-4000-8000-000000000001','agent.tool_execution_start',{toolCallId:'tool',toolName:'read'})
      sessions.events.insert(session.id,'00000000-0000-4000-8000-000000000001','agent.tool_execution_end',{toolCallId:'tool',result:'verified'})
      sessions.events.insert(session.id,'00000000-0000-4000-8000-000000000001','agent.message_end',{text:'Final message'})
    })
    const record = repository.execution(runId)
    assert.ok(JSON.stringify(record).length < 10000)
    assert.match(JSON.stringify(record), /verified/)
    assert.match(JSON.stringify(record), /Final message/)
    assert.equal(db.connection.prepare("SELECT count(*) AS n FROM events WHERE kind='agent.message_update'").get()!.n,1600)
  } finally { db.connection.close() }
})
