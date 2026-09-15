import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { publishWakeActivation } from '../../../src/modules/self-awake/activation-publication.ts'
import { wakeDeadline, wakeIntervalMs } from '../../../src/modules/self-awake/deadline.ts'

test('publication uses actual first execution, survives rereading, and does not modify scheduler state', () => {
 const root=mkdtempSync(path.join(tmpdir(),'wake-activation-')), db=new EdenDatabase(':memory:','mon')
 try {
  const sessions=new SessionRepository(db,'mon'), session=sessions.create('wake'), jobs=new JobRepository(db), repo=new SelfAwakeRepository(db)
  const job=jobs.schedule({kind:'self_awake',sessionId:session.id,dueAt:1,payload:{},key:'wake',causationId:'',depth:0})
  const run=repo.begin(job,{},{}), turn='00000000-0000-4000-8000-000000000001', state=path.join(root,'state.json')
  db.connection.prepare('UPDATE self_awake_runs SET turn_id=? WHERE id=?').run(turn,run)
  publishWakeActivation(db,state)
  assert.equal(existsSync(path.join(root,'agent_activation.json')),false)
  const event=sessions.events.append(session.id,turn,'agent.agent_start',{})
  publishWakeActivation(db,state)
  const first=readFileSync(path.join(root,'agent_activation.json'),'utf8')
  sessions.events.append(session.id,turn,'agent.agent_start',{})
  publishWakeActivation(db,state)
  assert.equal(readFileSync(path.join(root,'agent_activation.json'),'utf8'),first)
  assert.equal(wakeDeadline(db),Number(event.createdAt)+wakeIntervalMs)
  assert.equal(existsSync(state),false)
 } finally {db.close();rmSync(root,{recursive:true,force:true})}
})
