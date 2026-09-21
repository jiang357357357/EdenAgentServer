import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { selfAwakeToolTimerSchema } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { SelfAwakeContext, modelSelfAwakeContext } from '../../../src/modules/self-awake/context.ts'
import { selfAwakeTools } from '../../../src/modules/self-awake/tools.ts'
import { selfAwakePromptContext } from '../../../src/modules/self-awake/prompt.ts'

function fixture(t: test.TestContext) {
  const db = new EdenDatabase(':memory:', 'local'); t.after(() => db.close())
  const sessions = new SessionRepository(db, 'local'), jobs = new JobRepository(db), repo = new SelfAwakeRepository(db)
  const session = sessions.create('awake', [], { timezone: 'Asia/Shanghai' })
  const job = jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: Date.now(), key: 'parent', causationId: '', depth: 0, payload: {} })
  const request = { environment: { timezone: 'Asia/Shanghai' }, trigger: { type: 'scheduled', wake_reason: '历史巡检打算' }, recent_conversation: [{ userText: '一起聊游戏' }] }
  const run = repo.begin(job, request, {})
  db.connection.prepare("UPDATE self_awake_runs SET turn_id='turn',state='running' WHERE id=?").run(run)
  const activity = new SelfAwakeContext(repo, sessions)
  const tool = selfAwakeTools(repo, jobs, { async request() {} } as never, activity, session.id, 'turn').find(tool => tool.name === 'set_self_awake_timer')!
  return { db, repo, jobs, session, run, activity, tool, request }
}

test('timer returns readable persisted time and explicit watchdog adjustment', async t => {
  const f = fixture(t), now = Date.now(), anchor = now - 3600000
  f.db.connection.prepare("INSERT INTO realm_meta VALUES('self_awake_initial_anchor',?)").run(String(anchor))
  const requestedAt = now + 24 * 3600000
  const result = await f.tool.execute({ at: new Date(requestedAt).toISOString(), reason: '休息后醒来' }, { callId: 'timer', signal: new AbortController().signal }) as Record<string, any>
  const expected = anchor + 12 * 3600000
  assert.equal(result.dueAt, expected)
  assert.equal(result.scheduledAt, new Date(expected).toISOString())
  assert.equal(result.requestedAt, new Date(requestedAt).toISOString())
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.match(result.scheduledLocal, /GMT\+08:00/)
  assert.equal(result.adjusted, true)
  assert.equal(result.adjustment.reason, 'watchdog_deadline')
  assert.equal(f.jobs.read(result.id).dueAt, expected)
})

test('model timer accepts offset dates, rejects ambiguous dates and model-calculated timestamps', () => {
  assert.equal(selfAwakeToolTimerSchema.parse({ at: '2026-09-20T20:20:00+08:00' }).at, Date.parse('2026-09-20T12:20:00Z'))
  for (const at of ['1789858800000', 1789858800000, '2026-09-20T20:20:00', 'tomorrow']) assert.equal(selfAwakeToolTimerSchema.safeParse({ at }).success, false)
  assert.equal(selfAwakeToolTimerSchema.safeParse({ at: '2026-09-20T20:20:00+08:00', afterMinutes: 20 }).success, false)
})

test('diary directory is supplementary, full text is explicit, and request omits diary bodies', async t => {
  const f = fixture(t)
  f.repo.finish(f.run, '独特的历史全文')
  const signal = new AbortController().signal
  const directory = await f.activity.read(f.session.id, 'turn', { section: 'recent_diaries' }, signal)
  assert.doesNotMatch(JSON.stringify(directory), /独特的历史全文/)
  assert.match(JSON.stringify(directory), /contentAvailable/)
  const bulk = await f.activity.read(f.session.id, 'turn', { section: 'recent_diaries', includeContent: true }, signal)
  assert.doesNotMatch(JSON.stringify(bulk), /独特的历史全文/)
  const detail = await f.activity.read(f.session.id, 'turn', { section: 'recent_diaries', includeContent: true, query: '独特的历史' }, signal)
  assert.match(JSON.stringify(detail), /独特的历史全文/)
  const request = await f.activity.read(f.session.id, 'turn', { section: 'request' }, signal)
  assert.doesNotMatch(JSON.stringify(request), /独特的历史全文/)
  assert.match(JSON.stringify(request), /一起聊游戏/)
  const notes = await f.activity.read(f.session.id, 'turn', { section: 'wake_notes' }, signal)
  assert.doesNotMatch(JSON.stringify(notes), /历史巡检打算/)
  assert.match(JSON.stringify(notes), /wakeSchedule/)
})

test('scheduled reason is historical context and audit stays unchanged', () => {
  const raw = { trigger: { type: 'scheduled', wake_reason: '历史巡检打算', occurred_at: '2026-09-19T12:00:00Z' }, recent_diaries: [{ content: '旧日记全文' }] }
  const audit = { run: { id: 'run', status: 'running', request: raw, diaries: raw.recent_diaries }, recent_diaries: raw.recent_diaries }
  const before = JSON.stringify(audit), projection = selfAwakePromptContext(raw)
  assert.equal('wakeNotesAvailable' in projection, false)
  assert.doesNotMatch(JSON.stringify(projection), /历史巡检打算/)
  assert.equal('wake_reason' in projection.trigger, false)
  assert.doesNotMatch(JSON.stringify(modelSelfAwakeContext(audit)), /旧日记全文/)
  assert.equal(JSON.stringify(audit), before)
})
