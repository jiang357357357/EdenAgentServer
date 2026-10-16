import assert from 'node:assert/strict'
import test from 'node:test'
import { recordedModel } from '@eden/runtime-pi/testing'
import { selfAwakeHistoryFixture } from '../../helpers/self-awake-history.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { runtimeCallbacks } from '../../../src/modules/sessions/index.ts'
import { selfAwakeTools } from '../../../src/modules/self-awake/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { MemoryExtractionRepository, MemoryExtractionCommitRepository, MemoryExtractionRunner } from '../../../src/modules/memories/index.ts'
import { extractionActionEvidence } from '../../../src/modules/memories/extraction-evidence.ts'

for (const executeTimer of [false, true]) test(`real extraction runner ${executeTimer ? 'grounds the published timer' : 'rejects an unexecuted timer proposal'} with SQLite approval and receipts`, { timeout: 30000 }, async t => {
  const f = selfAwakeHistoryFixture(t), chat = f.chat()
  const permissions = new PermissionService(f.db, f.sessions.events)
  permissions.setMode('full_access')
  const callbacks = runtimeCallbacks(f.sessions, chat.input)
  if (executeTimer) await withAccount(f.alice, async () => {
    const timer = selfAwakeTools(f.awake, f.jobs, permissions, f.activity, chat.session.id, chat.input.turnId)
      .find(tool => tool.name === 'set_self_awake_timer')!
    await callbacks.beforeTool!('set_self_awake_timer', 'actual-timer', timer.revision, { afterMinutes: 10 })
    const result = await timer.execute({ afterMinutes: 10, reason: '真实临时计划' }, { callId: 'actual-timer', signal: new AbortController().signal })
    await callbacks.afterTool!('actual-timer', result, false, 'completed')
  })
  const answer = executeTimer ? '计划已经保存并投递。' : '如果老师允许，我想安排下次自醒。'
  f.sessions.events.append(chat.session.id, chat.input.turnId, 'agent.message_end', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
  chat.inputs.finish(chat.input)
  const jobs = new MemoryExtractionRepository(f.db), job = jobs.schedule(chat.input.id)!
  const model = await recordedModel([{ text: JSON.stringify({ memories: [{ kind: 'decision', content: '角色已保存并投递十分钟后的自醒计划', confidence: 0.95,
    basis: 'confirmed_action', action: 'set_self_awake_timer' }] }) }])
  const runner = new MemoryExtractionRunner(jobs, new MemoryExtractionCommitRepository(f.db), permissions, {
    async resolve() { return model.config }, async record(source, snapshot) {
      f.sessions.events.append(source.sessionId, source.turnId, 'memory.extraction.model_request', snapshot)
    },
  })
  t.after(async () => { await runner.close(); await model.close() })
  const ids = await withAccount(f.alice, () => runner.run(job.id, new AbortController().signal))
  assert.equal(ids.length, executeTimer ? 1 : 0)
  assert.equal(jobs.read(job.id).state, 'completed')
  assert.equal(permissions.list().filter(request => request.capability === 'memory.write').length, executeTimer ? 1 : 0)
  const messages = model.requests[0]!.messages as { role: string; content: string | { text: string }[] }[]
  const user = messages.find(message => message.role === 'user')!
  const payload = JSON.parse(typeof user.content === 'string' ? user.content : user.content[0]!.text)
  assert.equal(payload.actionEvidence.length, executeTimer ? 1 : 0)
  assert.doesNotMatch(JSON.stringify(payload.actionEvidence), /callId|sessionId|approvalId|requestId/)
  if (executeTimer) {
    assert.equal(payload.actionEvidence[0].effect, 'plan_saved_and_published')
    assert.ok(Number.isFinite(Date.parse(payload.actionEvidence[0].scheduledAt)))
    const memory = f.db.connection.prepare('SELECT metadata_json FROM memories WHERE id=?').get(ids[0]!)!
    assert.equal(JSON.parse(String(memory.metadata_json)).basis, 'confirmed_action')
  }
})

test('failed, unknown and another actor receipts do not ground the current actor execution facts', async t => {
  const f = selfAwakeHistoryFixture(t), chat = f.chat([f.actor, { assistantId: 9, characterId: 9 }])
  const result = { delivery: 'persisted_and_published', scheduledAt: new Date(Date.now() + 60000).toISOString() }
  for (const [actor, state] of [[4, 'failed'], [4, 'unknown'], [9, 'completed']] as const) {
    const callbacks = runtimeCallbacks(f.sessions, chat.input, { actor: { assistantID: actor } }), call = `${actor}-${state}`
    await callbacks.beforeTool!('set_self_awake_timer', call, 'fixture', {})
    await callbacks.afterTool!(call, result, state !== 'completed', state)
  }
  assert.deepEqual(extractionActionEvidence(f.db, { sessionId: chat.session.id, turnId: chat.input.turnId, actorId: '4' }), [])
  assert.equal(extractionActionEvidence(f.db, { sessionId: chat.session.id, turnId: chat.input.turnId, actorId: '9' }).length, 1)
})
