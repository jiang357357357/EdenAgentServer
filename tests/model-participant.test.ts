import test from 'node:test'
import assert from 'node:assert/strict'
import { modelParticipant, toJson } from '@eden/api'
import { sessionPromptContent } from '../src/modules/sessions/turn/session-prompt.ts'
import { actorSystemContent } from '../src/modules/actors/actor-prompt.ts'
import { modelSelfAwakeContext } from '../src/modules/self-awake/context.ts'
import { requestContext } from '../src/modules/sessions/turn/request-context.ts'

const character = { name: '测试角色', personality: '认真', system_prompt: '保留角色正文', speechStyle: '简洁',
  example_dialogue: [{ user: '你好', assistant: '老师好' }], setting_summary: { world: '学校', spine_assets: ['UI_ONLY'] },
  visual_actions: Array.from({ length: 1800 }, () => ({ name: 'UI_ONLY' })), costumes: ['UI_ONLY'], spine_assets: ['UI_ONLY'] }
const participant = { assistantId: 21, assistantName: '测试', avatarUrl: 'UI_ONLY', profile: { id: 21, api_key: 'UI_ONLY', character } }

test('model projection keeps narrative fields, omits UI resources and leaves original unchanged', () => {
  const original = JSON.stringify(participant)
  const result = modelParticipant(participant)
  assert.ok(!JSON.stringify(result).includes('UI_ONLY'))
  assert.ok(JSON.stringify(result).includes('保留角色正文'))
  assert.deepEqual(modelParticipant(result), result)
  assert.equal(JSON.stringify(participant), original)
  assert.ok(JSON.stringify(result).length < original.length / 20)
  const local = modelParticipant({ assistantId: 'local', profile: { personality: '认真', systemPrompt: '正文', avatarPath: 'UI_ONLY' } })
  assert.ok(JSON.stringify(local).includes('正文'))
  assert.ok(!JSON.stringify(local).includes('UI_ONLY'))
})
test('single and actor prompt boundaries project persisted full profiles and align usage/source metadata', () => {
  const metadata = toJson({ participants: [participant] })
  for (const context of [sessionPromptContent(metadata), actorSystemContent(toJson(participant), metadata)]) {
    assert.ok(!context.prompt.includes('UI_ONLY'))
    assert.ok(!JSON.stringify(context.sources).includes('UI_ONLY'))
    assert.ok(context.prompt.includes('老师好'))
    const usage = requestContext({ payload: { messages: [{ role: 'system', content: context.prompt }] } }, metadata, null)
    assert.ok(Number(usage.character) > 0)
  }
})
test('historical self-awake tool snapshots are projected without rewriting audits', () => {
  const audit = toJson({ run: { authorSnapshot: participant, request: { author: participant, trigger: { reason: '巡查' } } }, recent_diaries: [] })
  const original = JSON.stringify(audit), result = modelSelfAwakeContext(audit)
  assert.ok(!JSON.stringify(result).includes('UI_ONLY'))
  assert.ok(JSON.stringify(result).includes('巡查'))
  assert.equal(JSON.stringify(audit), original)
  assert.deepEqual(modelSelfAwakeContext({ run: null }), { run: null })
})
