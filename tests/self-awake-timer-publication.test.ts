import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { JobRepository } from '../src/modules/jobs/repository.ts'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { SelfAwakeRepository } from '../src/modules/self-awake/repository.ts'
import { selfAwakeTools } from '../src/modules/self-awake/tools.ts'

function fixture(context: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-wake-timer-'))
  const db = new EdenDatabase(':memory:', 'mon')
  context.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const stateFile = path.join(root, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ enabled: true, next_wake_at: null }))
  const jobs = new JobRepository(db, true), sessions = new SessionRepository(db, 'mon')
  const session = sessions.create('wake'), repository = new SelfAwakeRepository(db, stateFile)
  const permissions = { async request() {} }
  const tool = selfAwakeTools(repository, jobs, permissions as never, null as never, session.id, 'turn')[0]!
  const execute = (callId: string, afterMinutes: number) => tool.execute({ afterMinutes, reason: 'fixture' }, { callId, signal: new AbortController().signal })
  return { root, db, jobs, repository, execute }
}

test('timer tool replaces its durable plan and publishes the MonOs protocol without local execution', async context => {
  const f = fixture(context)
  await f.execute('one', 10)
  await f.execute('two', 20)
  const queued = f.jobs.list({ state: 'queued' })
  assert.equal(queued.length, 1)
  const requests = readdirSync(path.join(f.root, 'schedule_requests')).map(file => JSON.parse(readFileSync(path.join(f.root, 'schedule_requests', file), 'utf8')))
  const latest = requests.sort((a, b) => a.requested_at.localeCompare(b.requested_at)).at(-1)
  assert.equal(latest.request_id, queued[0]!.id)
  assert.equal(Date.parse(latest.next_wake_at), queued[0]!.dueAt)
  assert.equal(latest.reason, 'fixture')
  assert.equal(f.jobs.claim(Date.now() + 86400000), undefined)
  rmSync(path.join(f.root, 'schedule_requests'), { recursive: true })
  await f.execute('one', 10)
  assert.equal(f.jobs.list({ state: 'queued' })[0]!.id, queued[0]!.id)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_timer_publications').get()?.n, 2)
})

test('publication failure retains one durable plan for recovery and does not report success', async context => {
  const f = fixture(context)
  writeFileSync(path.join(f.root, 'schedule_requests'), 'not a directory')
  await assert.rejects(f.execute('one', 10), /delivery pending/)
  assert.equal(f.jobs.list({ state: 'queued' }).length, 1)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_timer_publications').get()?.n, 0)
  rmSync(path.join(f.root, 'schedule_requests'))
  f.repository.timerPublication.publish()
  assert.equal(f.repository.timerPublication.fault, undefined)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_timer_publications').get()?.n, 1)
})

test('denied approval preserves the current plan and never publishes a replacement', async context => {
  const f = fixture(context)
  await f.execute('approved', 10)
  const before = f.jobs.list({ state: 'queued' })[0]!
  const denied = { async request() { throw new Error('denied') } }
  const tool = selfAwakeTools(f.repository, f.jobs, denied as never, null as never, before.sessionId!, 'next-turn')[0]!
  await assert.rejects(tool.execute({ afterMinutes: 20, reason: 'denied' }, { callId: 'denied', signal: new AbortController().signal }), /denied/)
  assert.equal(f.jobs.list({ state: 'queued' })[0]!.id, before.id)
  assert.equal(readdirSync(path.join(f.root, 'schedule_requests')).length, 1)
})

test('actual timer result and published plan respect the persisted twelve-hour deadline', async context => {
  const f = fixture(context), anchor = Date.now() - 11 * 3600000
  writeFileSync(path.join(f.root, 'state.json'), JSON.stringify({ enabled: true, wake_anchor_at: new Date(anchor).toISOString() }))
  await f.execute('long', 1440)
  const first = f.jobs.list({ state: 'queued' })[0]!
  assert.equal(first.dueAt, anchor + 12 * 3600000)
  await f.execute('later', 2880)
  const next = f.jobs.list({ state: 'queued' })[0]!
  assert.equal(next.dueAt, first.dueAt)
  assert.equal(f.jobs.read(first.id).state, 'cancelled')
  const request = JSON.parse(readFileSync(path.join(f.root, 'schedule_requests', `${next.id}.json`), 'utf8'))
  assert.equal(Date.parse(request.next_wake_at), first.dueAt)
})
