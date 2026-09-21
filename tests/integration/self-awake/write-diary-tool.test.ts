import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { SelfAwakeRepository, SelfAwakeBridgeRepository, selfAwakeTools } from '../../../src/modules/self-awake/index.ts'
import type { SelfAwakeContext } from '../../../src/modules/self-awake/context.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'

for (const finalText of ['', '日记已保存，下次时钟也已设置。']) test(`diary tool preserves saved content with ${finalText ? 'acknowledgment' : 'empty completion'}`, async () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const owner = { key: 'owner', userId: '1', coreBaseUrl: 'http://localhost/' }
    const session = withAccount(owner, () => new SessionRepository(db, 'mon').create('wake'))
    const jobs = new JobRepository(db), repo = new SelfAwakeRepository(db)
    const job = new SelfAwakeBridgeRepository(db, jobs).submit('1', 'diary', 'hash', { kind: 'self_awake', sessionId: session.id, dueAt: Date.now(), payload: {}, key: 'diary', causationId: '', depth: 0 })
    const runId = repo.begin(job, {}, { characterId: 27 }), turn = randomUUID()
    db.connection.prepare("UPDATE self_awake_runs SET state='running',turn_id=? WHERE id=?").run(turn, runId)
    let denied = true
    const permissions = { async request() { if (denied) throw new Error('denied') } } as unknown as PermissionService
    const tool = selfAwakeTools(repo, jobs, permissions, {} as SelfAwakeContext, session.id, turn).find(t => t.name === 'write_diary')!
    const context = { callId: 'write', signal: new AbortController().signal }
    await assert.rejects(tool.execute({ content: '今天很安静。' }, context), /denied/)
    assert.equal(repo.read(runId).diaries.length, 0)
    denied = false
    await tool.execute({ title: '夜里', content: '今天很安静。' }, context)
    const saved = repo.read(runId)
    assert.equal(saved.status, 'running')
    assert.equal(saved.diaries.length, 1)
    const id = saved.diaries[0]!.id
    await tool.execute({ title: '夜里', content: '今天很安静。\n想记住这一刻。' }, context)
    assert.equal(repo.read(runId).diaries[0]!.id, id)
    assert.throws(() => repo.writeDiary(session.id, randomUUID(), { content: 'wrong turn' }), /当前自醒回合/)
    assert.throws(() => withAccount({ ...owner, key: 'other' }, () => repo.writeDiary(session.id, turn, { content: 'other' })), /不属于/)
    repo.finish(runId, finalText)
    assert.equal(repo.read(runId).diaries[0]!.content, '今天很安静。\n想记住这一刻。')
    assert.equal(repo.read(runId).diaries.length, 1)
    assert.equal(repo.read(runId).status, 'completed')
    await assert.rejects(tool.execute({ content: 'late' }, context), /已经结束/)
  } finally { db.close() }
})
