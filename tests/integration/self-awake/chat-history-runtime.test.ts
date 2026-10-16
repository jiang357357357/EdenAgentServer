import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedRuntime } from '@eden/runtime-pi'
import { recordedModel } from '@eden/runtime-pi/testing'
import { selfAwakeHistoryFixture } from '../../helpers/self-awake-history.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { runtimeCallbacks } from '../../../src/modules/sessions/index.ts'

test('actual actor subprocess, SQLite callbacks and HTTP/SSE model requests receive corrected diary and schedule tool results', { timeout: 30000 }, async t => {
  const f = selfAwakeHistoryFixture(t), bg = f.background(f.alice, f.actor, '给老师的日记', '老师，今晚想联系你。')
  f.plan(bg.id, Date.now() + 60000)
  const chat = f.chat()
  const model = await recordedModel([
    { tool: 'get_self_awake_context', input: { section: 'recent_diaries', query: '老师', includeContent: true } },
    { tool: 'get_self_awake_context', input: { section: 'wake_notes' } },
    { text: '已读到日记和已安排的下一次唤醒。' },
  ])
  t.after(() => model.close())
  await withAccount(f.alice, async () => {
    const runtime = createIsolatedRuntime({ sessionId: chat.session.id, systemPrompt: '根据工具返回的范围回答。', model: model.config,
      tools: chat.tools(), callbacks: runtimeCallbacks(f.sessions, chat.input) })
    try { await runtime.prompt(chat.input.text) } finally { await runtime.dispose() }
  })
  assert.equal(model.requests.length, 3)
  const messages = model.requests[2]!.messages as { role: string; content: string }[]
  const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
  assert.equal(results.length, 2)
  assert.equal(results[0].totalCount, 1)
  assert.equal(results[0].diaries[0].content, '老师，今晚想联系你。')
  assert.equal(results[1].wakeSchedule.status, 'scheduled')
  assert.equal(results[1].scheduledCount, 1)
  assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM tool_operations WHERE state='completed'").get()!.n, 2)
  assert.ok(f.sessions.checkpoint(chat.session.id))
  assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='self_awake' AND state='queued'").get()!.n, 1)
})
