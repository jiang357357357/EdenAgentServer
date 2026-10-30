import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { SelfAwakeContext, SelfAwakeRepository, SelfAwakeService, selfAwakeTools } from '../../../src/modules/self-awake/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'

for (const origin of ['mon', 'local'] as const) test(`${origin} diary rounds receive recent dialogue instead of previous diaries and investigations, preserving audit and current tool context`, { timeout: 30000 }, async () => {
  const oldDiary = 'OLD_DIARY_INVESTIGATION：继续排查 OLD_SERVER_FAILURE，下次还要检查服务。'
  const diary = 'NEW_PERSONAL_DIARY：老师说起了晚霞。我想记住我们一起慢下来的这一刻。'
  const model = await recordedModel([
    { tool: 'write_diary', input: { title: '旧日记', content: oldDiary } },
    { text: 'OLD_ROUND_FINAL：下一次继续巡检。' },
    { tool: 'get_self_awake_context', input: { section: 'request' } },
    { tool: 'write_diary', input: { title: '晚霞', content: diary } },
    { text: '这篇日记已经保存。' },
  ])
  const db = new EdenDatabase(':memory:', origin), repository = new SessionRepository(db, origin)
  const account = origin === 'mon' ? { key: accountKey('http://127.0.0.1:1', 'fixture'), userId: 'fixture', coreBaseUrl: 'http://127.0.0.1:1' } : undefined
  if (account) db.connection.prepare("INSERT INTO realm_meta(key,value) VALUES('account_key',?)").run(account.key)
  const jobs = new JobRepository(db), awake = new SelfAwakeRepository(db)
  const context = new SelfAwakeContext(awake, repository), permissions = new PermissionService(db, repository.events, () => false)
  permissions.setMode('full_access')
  const sessions = new SessionService(repository, model.config,
    (id, turn) => selfAwakeTools(awake, jobs, permissions, context, id, turn))
  const service = new SelfAwakeService(awake, jobs, sessions)
  const actor = { assistantId: 4, characterId: 4, profile: { character: { name: '普拉娜', system_prompt: '你是普拉娜。PERSONA_KEPT。' } } }
  const background = withAccount(account, () => repository.create('角色后台', [actor], { sessionPurpose: 'self_awake' }, { purpose: 'self_awake', sourceChannel: 'internal' }))
  const inputs = new InputRepository(db, repository.events)
  const conversation = (text: string, reply: string, participant = actor) => withAccount(account, () => {
    const chat = repository.create('老师的聊天', [participant])
    const accepted = inputs.enqueue(chat.id, text, randomUUID(), { participants: [participant] })
    const input = inputs.claim(chat.id)!
    inputs.finish(input)
    repository.events.append(chat.id, accepted.turnId, 'agent.message_end', { actor: { assistantID: participant.assistantId },
      message: { role: 'assistant', stopReason: 'stop', content: reply } })
    return chat
  })
  const run = async () => withAccount(account, async () => {
    const job = jobs.schedule({ kind: 'self_awake', sessionId: background.id, dueAt: Date.now() - 1,
      key: randomUUID(), causationId: '', depth: 0, payload: {} })
    assert.equal(jobs.claim()!.id, job.id)
    service.dispatch(jobs.read(job.id))
    await sessions.waitForIdle(background.id)
    await setImmediate()
    jobs.settleInputs()
    const record = awake.list({}).results.find(value => value.jobId === job.id)!
    assert.equal(record.status, 'completed')
    return record
  })
  try {
    service.start()
    const archivedPlan = jobs.schedule({ kind: 'self_awake', sessionId: background.id, dueAt: Date.now() + 60000,
      key: randomUUID(), causationId: '', depth: 0, payload: { prompt: 'OLD_ARCHIVED_PLAN：巡检机器。' } })
    db.connection.prepare(`INSERT INTO self_awake_merged_plans(job_id,scope_key,session_id,due_at,payload_json,merged_at)
      VALUES(?,?,?,?,?,?)`).run(archivedPlan.id, awake.roles.payload(background.id).roleScope!, background.id,
        archivedPlan.dueAt, JSON.stringify(archivedPlan.payload), Date.now())
    conversation('OLD_CHAT_TECHNICAL：昨天的服务故障。', '昨天已经记录了故障。')
    const first = await run()
    const firstAudit = JSON.stringify(awake.execution(first.id))
    assert.match(firstAudit, /OLD_DIARY_INVESTIGATION/)
    assert.match(JSON.stringify(repository.checkpoint(background.id)), /OLD_DIARY_INVESTIGATION/)
    conversation('NEW_CHAT_SUNSET：今天的晚霞很好看，想和你慢慢聊一会儿。', '我们可以一起安静地看一会儿。')
    conversation('OTHER_CHARACTER_CONVERSATION', '不属于当前角色。', { ...actor, assistantId: 99, characterId: 99 })
    const second = await run()
    assert.equal(model.requests.length, 5)
    const opening = JSON.stringify(model.requests[2])
    assert.match(opening, /NEW_CHAT_SUNSET/)
    assert.match(opening, /PERSONA_KEPT/)
    assert.match(opening, /日记不是工作日志/)
    assert.doesNotMatch(opening, /OLD_DIARY_INVESTIGATION|OLD_SERVER_FAILURE|OLD_ROUND_FINAL|OLD_CHAT_TECHNICAL|OTHER_CHARACTER_CONVERSATION|OLD_ARCHIVED_PLAN/)
    assert.match(JSON.stringify(model.requests[3]), /get_self_awake_context/)
    assert.match(JSON.stringify(model.requests[4]), /NEW_PERSONAL_DIARY/)
    assert.equal(awake.read(first.id).diaries[0]!.content, oldDiary)
    assert.equal(awake.read(second.id).diaries[0]!.content, diary)
    assert.equal(JSON.stringify(awake.execution(first.id)), firstAudit)
    assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM tool_operations WHERE state='completed'").get()!.count, 3)
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS count FROM self_awake_diaries').get()!.count, 2)
    assert.equal(db.connection.prepare('SELECT reviewed_at FROM self_awake_merged_plans WHERE job_id=?').get(archivedPlan.id)!.reviewed_at, null)
  } finally { service.close(); await sessions.close(); db.close(); await model.close() }
})

test('ordinary conversation and other scheduled jobs retain their existing dialogue history', { timeout: 20000 }, async () => {
  const model = await recordedModel([{ text: 'ORDINARY_REPLY_1' }, { text: 'ORDINARY_REPLY_2' }, { text: 'HOOK_REPLY' }])
  const db = new EdenDatabase(':memory:', 'local'), repository = new SessionRepository(db, 'local')
  const sessions = new SessionService(repository, model.config)
  try {
    const chat = repository.create('普通对话')
    await sessions.start(chat.id, 'ORDINARY_USER_1'); await sessions.waitForIdle(chat.id)
    await sessions.start(chat.id, 'ORDINARY_USER_2'); await sessions.waitForIdle(chat.id)
    sessions.submitJob(chat.id, 'HOOK_INPUT', randomUUID(), 'plugin.hook', () => {})
    await sessions.waitForIdle(chat.id)
    assert.equal(model.requests.length, 3)
    assert.match(JSON.stringify(model.requests[1]), /ORDINARY_USER_1/)
    assert.match(JSON.stringify(model.requests[1]), /ORDINARY_REPLY_1/)
    assert.match(JSON.stringify(model.requests[2]), /ORDINARY_USER_1/)
    assert.match(JSON.stringify(model.requests[2]), /ORDINARY_REPLY_2/)
  } finally { await sessions.close(); db.close(); await model.close() }
})
