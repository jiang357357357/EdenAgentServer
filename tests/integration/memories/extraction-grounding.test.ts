import assert from 'node:assert/strict'
import test from 'node:test'
import { recordedModel } from '@eden/runtime-pi/testing'
import { extractMemoryCandidates } from '../../../src/modules/memories/index.ts'

test('real extraction request excludes proposals, unsupported decisions and ungrounded execution claims', { timeout: 30000 }, async t => {
  const model = await recordedModel([{ text: JSON.stringify({ memories: [
    { kind: 'decision', content: '角色决定排下次自醒', confidence: 0.95, basis: 'assistant_proposal' },
    { kind: 'decision', content: '已安排自醒', confidence: 0.95, basis: 'confirmed_action', action: 'set_self_awake_timer' },
    { kind: 'decision', content: '无来源的决定', confidence: 0.95 },
    { kind: 'fact', content: '错误的用户陈述', confidence: 0.95, basis: 'user_statement', sourceQuote: '并不存在的原话' },
    { kind: 'preference', content: '用户偏好晚上联系', confidence: 0.95, basis: 'user_statement', sourceQuote: '我喜欢晚上联系' },
  ] }) }])
  t.after(() => model.close())
  const candidates = await extractMemoryCandidates({ model: model.config, userText: '我喜欢晚上联系，你的日记怎么没有找我的打算？',
    assistantText: '如果老师允许，我想安排下次自醒。', signal: new AbortController().signal, async record() {} })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.kind, 'preference')
  const messages = model.requests[0]!.messages as { role: string; content: string | { text: string }[] }[]
  const user = messages.find(message => message.role === 'user')!
  const payload = JSON.parse(typeof user.content === 'string' ? user.content : user.content[0]!.text)
  assert.equal(payload.assistantReplyStatus, 'unverified_character_report')
  assert.deepEqual(payload.actionEvidence, [])
  assert.match(JSON.stringify(messages.find(message => message.role === 'system')), /提议|待授权/)
})
