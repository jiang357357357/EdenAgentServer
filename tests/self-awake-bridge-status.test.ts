import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SelfAwakeBridgeRepository } from '../src/modules/self-awake/bridge-repository.ts'
import { SelfAwakeRepository } from '../src/modules/self-awake/repository.ts'
import { JobRepository } from '../src/modules/jobs/repository.ts'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'

test('MonOs keeps polling queued and in-progress self-awake jobs', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const jobs = new JobRepository(db), bridge = new SelfAwakeBridgeRepository(db, jobs)
    const session = new SessionRepository(db, 'mon').create('wake')
    const job = bridge.submit('2', 'key', 'hash', { kind: 'self_awake', sessionId: session.id,
      dueAt: Date.now(), payload: {}, key: 'wake', causationId: '', depth: 0 })
    assert.equal(bridge.status('2', job.id).status, 'pending')
    assert.throws(() => bridge.status('1', job.id), /owner mismatch/)
    const run = new SelfAwakeRepository(db).begin(job, {}, {})
    for (const [state, expected] of [['preparing', 'pending'], ['running', 'running'], ['awaiting_action', 'running'],
      ['action_running', 'running'], ['completed', 'completed'], ['action_interrupted', 'failed']]) {
      db.connection.prepare('UPDATE self_awake_runs SET state=? WHERE id=?').run(state!, run)
      assert.equal(bridge.status('2', job.id).status, expected)
    }
  } finally { db.connection.close() }
})
