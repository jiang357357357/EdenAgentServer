import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EdenDatabase } from '@eden/store'
import { selfAwakeHistoryFixture } from '../../helpers/self-awake-history.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { SelfAwakeRepository, SelfAwakeContext } from '../../../src/modules/self-awake/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'

test('real SQLite chat sees its eleven character diaries and four confirmed MonOs session plans, excluding other identities', async t => {
  const f = selfAwakeHistoryFixture(t)
  const backgrounds = Array.from({ length: 11 }, (_, i) => f.background(f.alice, f.actor, `日记 ${i}`))
  const foreign = f.background(f.bob, f.actor, 'OTHER_ACCOUNT_SECRET', 'OTHER_ACCOUNT_SECRET')
  const otherActor = f.background(f.alice, { ...f.actor, assistantId: 9, characterId: 9 }, 'OTHER_ROLE_SECRET', 'OTHER_ROLE_SECRET')
  const now = Date.now()
  backgrounds.slice(0, 4).forEach((session, i) => f.plan(session.id, now + (i + 1) * 60000))
  f.plan(foreign.id, now + 1000, true, f.bob)
  f.plan(otherActor.id, now + 2000)
  const chat = f.chat()
  const directory = await chat.read({ section: 'recent_diaries', limit: 5 }) as any
  assert.equal(directory.count, 11)
  assert.equal(directory.totalCount, 11)
  assert.equal(directory.diaries.length, 5)
  assert.equal(directory.hasMore, true)
  assert.deepEqual(directory.scope, { kind: 'character', characterId: '4', coverage: 'owned_character_sessions' })
  assert.doesNotMatch(JSON.stringify(directory), /OTHER_ACCOUNT_SECRET|OTHER_ROLE_SECRET|accountKey|sessionId/)
  const notes = await chat.read({ section: 'wake_notes' }) as any
  assert.equal(notes.scheduledCount, 4)
  assert.equal(notes.wakeSchedule.status, 'scheduled')
  assert.equal(notes.wakeSchedule.nextWakeAt, new Date(now + 60000).toISOString())
  assert.equal(notes.schedules.length, 4)
  assert.doesNotMatch(JSON.stringify(notes), /历史计划说明|sessionId|accountKey/)
  const request = await chat.read({ section: 'request' }) as any
  assert.equal(request.run, null)
  assert.equal(request.scope.kind, 'character')
  assert.equal(request.scheduledCount, 4)
  assert.equal(request.wakeSchedule.status, 'scheduled')
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_diaries').get()!.n, 13)
  const confirmation = JSON.parse(readFileSync(join(f.root, 'sessions', backgrounds[0]!.id, 'state.json'), 'utf8'))
  assert.equal(confirmation.next_wake_at, notes.wakeSchedule.nextWakeAt)
})

test('topic filtering precedes LIMIT, explicit content mode is clear, and empty matches differ from empty history', async t => {
  const f = selfAwakeHistoryFixture(t)
  const old = f.background(f.alice, f.actor, '旧主题', 'OLDER_TOPIC：老师，想联系你。')
  f.db.connection.prepare('UPDATE self_awake_diaries SET created_at=1 WHERE session_id=?').run(old.id)
  for (let i = 0; i < 6; i++) f.background(f.alice, f.actor, `普通记录 ${i}`, '普通正文')
  const chat = f.chat()
  const directory = await chat.read({ section: 'recent_diaries', includeContent: true, limit: 5 }) as any
  assert.equal(directory.contentMode, 'directory')
  assert.match(directory.contentReason, /query/)
  assert.doesNotMatch(JSON.stringify(directory.diaries), /普通正文/)
  const topic = await chat.read({ section: 'recent_diaries', query: 'older_topic', includeContent: true, limit: 1 }) as any
  assert.equal(topic.count, 1)
  assert.equal(topic.totalCount, 7)
  assert.equal(topic.diaries[0].content, 'OLDER_TOPIC：老师，想联系你。')
  assert.equal(topic.hasMore, false)
  const missing = await chat.read({ section: 'recent_diaries', query: "not found' OR 1=1 --" }) as any
  assert.equal(missing.count, 0)
  assert.equal(missing.totalCount, 7)
  assert.equal(missing.emptyReason, 'no_matching_diaries')
})

test('multiple actors use the executing input snapshot, including after roster edits, and reject ambiguous callers', async t => {
  const f = selfAwakeHistoryFixture(t)
  f.background(f.alice, f.actor, 'ROLE_FOUR')
  f.background(f.alice, { ...f.actor, assistantId: 9, characterId: 9 }, 'ROLE_NINE')
  const chat = f.chat([f.actor, { assistantId: 9, characterId: 9 }])
  await assert.rejects(chat.read({ section: 'recent_diaries' }), /行动角色/)
  await assert.rejects(chat.read({ section: 'recent_diaries' }, 99), /不属于/)
  withAccount(f.alice, () => f.sessions.setMetadata(chat.session.id, [{ assistantId: 9, characterId: 9 }]))
  const four = await chat.read({ section: 'recent_diaries' }, 4)
  assert.match(JSON.stringify(four), /ROLE_FOUR/)
  assert.doesNotMatch(JSON.stringify(four), /ROLE_NINE/)
  const nine = await chat.read({ section: 'recent_diaries' }, 9)
  assert.match(JSON.stringify(nine), /ROLE_NINE/)
  await assert.rejects(withAccount(f.bob, () => f.activity.read(chat.session.id, chat.input.turnId,
    { section: 'recent_diaries' }, new AbortController().signal, 4)), /不属于/)
})

test('unconfirmed plans remain unscheduled with a specific explanation, and unavailable state stays visible', async t => {
  const f = selfAwakeHistoryFixture(t), bg = f.background(), chat = f.chat()
  f.plan(bg.id, Date.now() + 60000, false)
  const notes = await chat.read({ section: 'wake_notes' }) as any
  assert.equal(notes.scheduledCount, 0)
  assert.equal(notes.wakeSchedule.status, 'unscheduled')
  assert.match(notes.wakeSchedule.reason, /本会话/)
  const unavailable = new SelfAwakeContext(new SelfAwakeRepository(f.db, undefined, true), f.sessions)
  const result = await withAccount(f.alice, () => unavailable.read(chat.session.id, chat.input.turnId,
    { section: 'wake_notes' }, new AbortController().signal)) as any
  assert.equal(result.wakeSchedule.status, 'unavailable')
  assert.match(result.wakeSchedule.reason, /调度未配置/)
})

test('missing identity falls back explicitly to the current session, and temporary database reopen preserves scope', async t => {
  const f = selfAwakeHistoryFixture(t)
  f.background()
  const chat = f.chat()
  const fallback = await withAccount(f.alice, () => f.activity.read(chat.session.id, 'missing-turn',
    { section: 'recent_diaries' }, new AbortController().signal)) as any
  assert.equal(fallback.scope.kind, 'session')
  assert.equal(fallback.count, 0)
  assert.equal(fallback.emptyReason, 'no_diaries_in_scope')
  assert.match(fallback.interpretation, /其他后台会话/)
  const reopened = new EdenDatabase(f.filename, 'mon')
  try {
    const context = new SelfAwakeContext(new SelfAwakeRepository(reopened, f.stateFile, true), new SessionRepository(reopened, 'mon'))
    const result = await withAccount(f.alice, () => context.read(chat.session.id, chat.input.turnId,
      { section: 'recent_diaries' }, new AbortController().signal)) as any
    assert.equal(result.count, 1)
    await assert.rejects(withAccount({ ...f.alice, key: accountKey(f.alice.coreBaseUrl, 'unknown') }, () => context.read(
      chat.session.id, chat.input.turnId, { section: 'recent_diaries' }, new AbortController().signal)), /不属于/)
  } finally { reopened.close() }
})

test('group conversations cannot read personal history or schedules, even with matching account and character', async t => {
  const f = selfAwakeHistoryFixture(t), chat = f.chat()
  f.background()
  f.db.connection.prepare('INSERT INTO qq_group_sessions(session_id,bot_qq,group_qq,operator_qq,created_at) VALUES(?,?,?,?,?)')
    .run(chat.session.id, 'bot-fixture', 'group-fixture', 'operator-fixture', Date.now())
  for (const section of ['recent_diaries', 'wake_notes']) await assert.rejects(chat.read({ section }), /群会话/)
})

test('bounded schedule coverage is explicit and cannot turn unexamined sessions into a global unscheduled claim', async t => {
  const f = selfAwakeHistoryFixture(t), chat = f.chat()
  withAccount(f.alice, () => {
    for (let i = 0; i < 129; i++) f.sessions.create(`背景 ${i}`, [f.actor], { sessionPurpose: 'self_awake' },
      { purpose: 'self_awake', sourceChannel: 'internal' })
  })
  const notes = await chat.read({ section: 'wake_notes' }) as any
  assert.equal(notes.truncated, true)
  assert.equal(notes.wakeSchedule.status, 'unavailable')
  assert.match(notes.wakeSchedule.reason, /覆盖不完整/)
})

test('local realm character history works without a Core identity and stays within its current character', async t => {
  const db = new EdenDatabase(':memory:', 'local'); t.after(() => db.close())
  const sessions = new SessionRepository(db, 'local'), jobs = new JobRepository(db), awake = new SelfAwakeRepository(db)
  const participant = { characterId: 'local-character', name: '本地角色' }
  const bg = sessions.create('本地自醒', [participant])
  const job = jobs.schedule({ kind: 'self_awake', sessionId: bg.id, dueAt: Date.now(), payload: {}, key: 'local-history', causationId: '', depth: 0 })
  const run = awake.begin(job, {}, participant)
  db.connection.prepare("UPDATE self_awake_runs SET state='running' WHERE id=?").run(run)
  awake.finish(run, 'LOCAL_DIARY')
  const chat = sessions.create('本地聊天', [participant]), inputs = new InputRepository(db, sessions.events)
  inputs.enqueue(chat.id, '查看日记', 'local-chat', { participants: [participant] })
  const input = inputs.claim(chat.id)!
  const context = new SelfAwakeContext(awake, sessions)
  const result = await context.read(chat.id, input.turnId, { section: 'recent_diaries' }, new AbortController().signal) as any
  assert.equal(result.count, 1)
  assert.equal(result.scope.characterId, 'local-character')
})
