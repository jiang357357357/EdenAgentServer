import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import { accountKey, withAccount, type Account } from '../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../src/modules/sessions/index.ts'
import { InputRepository } from '../../src/modules/sessions/input/input-repository.ts'
import { JobRepository } from '../../src/modules/jobs/index.ts'
import { SelfAwakeRepository, SelfAwakeContext, selfAwakeTools } from '../../src/modules/self-awake/index.ts'
import type { PermissionService } from '../../src/modules/permissions/index.ts'

export function selfAwakeHistoryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'eden-awake-history-'))
  const filename = join(root, 'test.sqlite'), stateFile = join(root, 'state.json')
  const db = new EdenDatabase(filename, 'mon'), sessions = new SessionRepository(db, 'mon')
  const jobs = new JobRepository(db, true), awake = new SelfAwakeRepository(db, stateFile, true)
  const activity = new SelfAwakeContext(awake, sessions)
  const alice: Account = { key: accountKey('http://127.0.0.1:1', 'alice'), coreBaseUrl: 'http://127.0.0.1:1', userId: 'alice' }
  const bob: Account = { ...alice, key: accountKey(alice.coreBaseUrl, 'bob'), userId: 'bob' }
  const actor = { assistantId: 4, characterId: 4, name: '普拉娜' }
  writeFileSync(stateFile, JSON.stringify({ enabled: true, next_wake_at: null }))
  writeFileSync(join(root, 'session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true, expiresAt: Date.now() + 60000 }))
  t.after(() => {
    db.close()
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected history fixture path')
    rmSync(root, { recursive: true, force: true })
  })
  const background = (owner = alice, participant = actor, title = '历史', content = '老师，今天想聊一聊。') => withAccount(owner, () => {
    const session = sessions.create('后台自醒', [participant], { sessionPurpose: 'self_awake', selfAwakeUserId: owner.userId },
      { purpose: 'self_awake', sourceChannel: 'internal' })
    const job = jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: Date.now(), key: randomUUID(), causationId: '', depth: 0, payload: {} })
    const run = awake.begin(job, {}, participant)
    db.connection.prepare("UPDATE self_awake_runs SET state='running' WHERE id=?").run(run)
    awake.finish(run, content)
    db.connection.prepare('UPDATE self_awake_diaries SET title=? WHERE run_id=?').run(title, run)
    db.connection.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(job.id)
    return session
  })
  const plan = (sessionId: string, dueAt: number, confirmed = true, owner = alice) => withAccount(owner, () => {
    const job = jobs.schedule({ kind: 'self_awake', sessionId, dueAt, key: randomUUID(), causationId: '', depth: 0,
      payload: { prompt: '老师，稍后再见。', scheduleScope: 'session' } })
    awake.timerPublication.publish(sessionId)
    if (confirmed) {
      const directory = join(root, 'sessions', sessionId)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'state.json'), JSON.stringify({ session_id: sessionId, enabled: true,
        next_wake_at: new Date(dueAt).toISOString(), next_wake_source: 'agent', next_wake_reason: '历史计划说明' }))
    }
    return job
  })
  const chat = (participants: JsonValue[] = [actor], owner = alice) => withAccount(owner, () => {
    const session = sessions.create('聊天', participants)
    const inputs = new InputRepository(db, sessions.events)
    inputs.enqueue(session.id, '我看你的自醒日记里，没什么找我的打算？', randomUUID(), { participants })
    const input = inputs.claim(session.id)!
    const tools = (actorId?: string | number) => selfAwakeTools(awake, jobs, {} as PermissionService, activity, session.id, input.turnId, actorId)
    const read = (args: Record<string, unknown>, actorId?: string | number) => withAccount(owner, () =>
      tools(actorId).find(tool => tool.name === 'get_self_awake_context')!.execute(args, { callId: randomUUID(), signal: new AbortController().signal }))
    return { session, input, inputs, read, tools }
  })
  return { root, filename, stateFile, db, sessions, jobs, awake, activity, alice, bob, actor, background, plan, chat }
}
