import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'

test('MonOs schedule overrides old queued handoff, reports retry/disabled and never falls back on read errors', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wake-source-')), file = path.join(root, 'state.json')
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const session = new SessionRepository(db, 'mon').create('wake')
    new JobRepository(db, true).schedule({ kind: 'self_awake', sessionId: session.id, dueAt: Date.now() - 1000,
      payload: {}, key: 'old', causationId: '', depth: 0 })
    const repo = new SelfAwakeRepository(db, file)
    const next = new Date(Date.now() + 60000).toISOString()
    writeFileSync(file, JSON.stringify({ enabled: true, next_wake_at: next }))
    assert.equal(repo.list({}).schedule?.nextWakeAt, next)
    writeFileSync(file, JSON.stringify({ enabled: true, next_wake_at: next, consecutive_agent_failures: 3, last_error: 'connection refused' }))
    assert.equal(repo.list({}).schedule?.status, 'retrying')
    writeFileSync(file, JSON.stringify({ enabled: false }))
    assert.equal(repo.list({}).schedule?.status, 'disabled')
    writeFileSync(file, '{')
    assert.throws(() => repo.list({}), /无法读取 MonOs/)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test('interruption details come from the matching persisted input event', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const sessions = new SessionRepository(db, 'mon'), session = sessions.create('wake')
    sessions.events.append(session.id, null, 'input.interrupted', { inputId: 'target', reason: 'Server restarted during execution' })
    sessions.events.append(session.id, null, 'input.interrupted', { inputId: 'other', reason: 'unrelated' })
    const repo = new SelfAwakeRepository(db)
    assert.match(repo.inputFailure(session.id, 'target', 'interrupted'), /服务在执行期间重启/)
    assert.doesNotMatch(repo.inputFailure(session.id, 'target', 'interrupted'), /unrelated/)
  } finally { db.close() }
})
