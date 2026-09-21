import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import { SessionRepository, recentSharedTopics } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { selfAwakePrompt } from '../../../src/modules/self-awake/prompt.ts'
import { sessionPromptContent } from '../../../src/modules/sessions/turn/session-prompt.ts'

function fixture(t: test.TestContext) {
  const db = new EdenDatabase(':memory:', 'mon'); t.after(() => db.close())
  const sessions = new SessionRepository(db, 'mon'), inputs = new InputRepository(db, sessions.events)
  const account = (userId: string) => ({ key: accountKey('http://localhost:40011', userId), userId, coreBaseUrl: 'http://localhost:40011' })
  const session = (userId = '1') => withAccount(account(userId), () => sessions.create('Topics'))
  const add = (id: string, text: string, extra: Record<string, JsonValue> = {}) => {
    const accepted = inputs.enqueue(id, text, randomUUID(), { participants: [{ characterId: 27 }], ...extra })
    const running = inputs.claim(id)!
    inputs.finish(running)
    return accepted.inputId
  }
  return { db, session, add, account }
}

test('shared topics isolate account and character, exclude background input and retain older real dialogue', t => {
  const f = fixture(t), source = f.session(), current = f.session(), other = f.session('2')
  f.add(source.id, '共同话题')
  f.add(other.id, '别人的秘密')
  f.add(source.id, '其他角色', { participants: [{ characterId: 99 }] })
  f.add(source.id, '后台任务', { job: { kind: 'self_awake' } })
  f.add(source.id, '自醒记录', { environment: { sessionPurpose: 'self_awake' } })
  f.add(source.id, '内部交接', { internalHandoff: true })
  const old = f.add(source.id, '旧话题')
  f.db.connection.prepare('UPDATE inputs SET created_at=? WHERE id=?').run(Date.now() - 15 * 86400000, old)
  assert.deepEqual(recentSharedTopics(f.db, current.id, { characterId: 27 }).map(t => t.userText), ['旧话题', '共同话题'])
  assert.deepEqual(recentSharedTopics(f.db, current.id, {}), [])
  assert.throws(() => withAccount(f.account('2'), () => recentSharedTopics(f.db, current.id, { characterId: 27 })), /不属于/)
})

test('topic excerpts are bounded, dated, and internal recall queries stay out of system prose', t => {
  const f = fixture(t), source = f.session(), current = f.session()
  for (let i = 0; i < 8; i++) {
    const id = f.add(source.id, `${i}` + '😀'.repeat(9000))
    f.db.connection.prepare('UPDATE inputs SET created_at=? WHERE id=?').run(Date.now() - 10000 + i, id)
  }
  const topics = recentSharedTopics(f.db, current.id, { profile: { character: { id: 27 } } })
  assert.equal(topics.length, 3)
  assert.ok(topics.every(topic => topic.turnState === 'completed'))
  assert.equal(topics[0]!.userText[0], '5')
  assert.ok(topics.every(t => Array.from(t.userText).length === 8000 && t.truncated && Number.isFinite(Date.parse(t.occurredAt))))
  const prompt = selfAwakePrompt({ recent_conversation: topics, wakeSchedule: { status: 'scheduled' }, current_time: 'now' })
  assert.ok(prompt.includes('recent_conversation'))
  assert.ok(prompt.includes('wakeSchedule'))
  assert.ok(!sessionPromptContent({ recallQuery: 'internal-search-only', participants: [] }).prompt.includes('internal-search-only'))
})

test('only latest chat contributes three user/reply rounds, without tool output or other actor replies', t => {
  const f = fixture(t), earlier = f.session(), latest = f.session(), current = f.session()
  f.add(earlier.id, 'older chat')
  const events = new SessionRepository(f.db, 'mon').events
  for (let index = 0; index < 4; index++) {
    const id = f.add(latest.id, `question-${index}`, { participants: [{ characterId: 27, assistantId: 7 }] })
    f.db.connection.prepare('UPDATE inputs SET created_at=? WHERE id=?').run(Date.now() + index + 100, id)
    const row = f.db.connection.prepare('SELECT turn_id FROM inputs WHERE id=?').get(id)!
    const turn = String(row.turn_id)
    events.append(latest.id, turn, 'agent.message_end', { actor: { assistantID: 7 }, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'internal preamble' }] } })
    events.append(latest.id, turn, 'agent.message_end', { actor: { assistantID: 7 }, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: `reply-${index}` }] } })
    events.append(latest.id, turn, 'agent.message_end', { actor: { assistantID: 99 }, message: { role: 'assistant', stopReason: 'stop', content: 'other actor' } })
  }
  const result = recentSharedTopics(f.db, current.id, { characterId: 27 })
  assert.deepEqual(result.map(r => [r.userText, r.assistantText]), [['question-1', 'reply-1'], ['question-2', 'reply-2'], ['question-3', 'reply-3']])
  assert.ok(result.every(r => r.sessionId === latest.id && r.replyAvailable))
})
