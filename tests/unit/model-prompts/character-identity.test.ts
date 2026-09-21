import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionPromptContent } from '../../../src/modules/sessions/turn/session-prompt.ts'
import { actorSystemContent } from '../../../src/modules/actors/actor-prompt.ts'
import { historicalContextSources } from '../../../src/modules/sessions/context-sources.ts'
import { characterIdentity } from '../../../src/model-prompts/character-identity.ts'
import { selfAwakeInstruction } from '../../../src/model-prompts/self-awake.ts'

const rio = { characterId: 27, profile: { character: { name: '调月莉音', system_prompt: '你是调月莉音。你有自己的审美和选择。' } } }
const kei = { characterId: 28, profile: { character: { name: '天童凯伊', system_prompt: '你是天童凯伊。你珍惜自己的名字和选择。' } } }

test('single and selected actor use character identity before host conditions without mixing identities', () => {
  const original = JSON.stringify(rio)
  for (const context of [sessionPromptContent({ participants: [rio] }), actorSystemContent(rio, { participants: [rio, kei] })]) {
    assert.ok(context.prompt.startsWith(rio.profile.character.system_prompt + '\n\n'))
    assert.doesNotMatch(context.prompt, /你是 Eden Agent|你是当前指定的 Eden|天童凯伊/)
    assert.match(context.prompt, /工具按已有权限执行/)
    assert.equal(context.sources[0]?.kind, 'character')
    const recovered = historicalContextSources({ payload: { messages: [{ role: 'system', content: context.prompt }] } }) as Record<string, any>
    assert.equal(recovered.contextSources[0].content, rio.profile.character.system_prompt)
  }
  assert.ok(actorSystemContent(kei).prompt.startsWith(kei.profile.character.system_prompt))
  assert.equal(JSON.stringify(rio), original)
})

test('missing identity and multiple unselected participants do not invent a role; local camelCase remains supported', () => {
  assert.equal(characterIdentity({ profile: { systemPrompt: '你是本地角色。' } }), '你是本地角色。')
  assert.equal(characterIdentity({ characterName: '莉音' }), '你是莉音。')
  assert.equal(characterIdentity({}), '')
  assert.ok(!sessionPromptContent({ participants: [rio, kei] }).prompt.startsWith('你是调月莉音'))
  assert.doesNotMatch(sessionPromptContent({}).prompt, /你是 Eden Agent/)
})

test('wake trigger leaves activity choice open and keeps persisted timing and context', () => {
  const prompt = selfAwakeInstruction({ current_time: '2026-09-20T01:00:00+08:00', wakeSchedule: { status: 'paused' } })
  assert.match(prompt, /用 write_diary 写日记/)
  assert.match(prompt, /2026-09-20T01:00:00\+08:00/)
  assert.match(prompt, /"status":"paused"/)
  assert.doesNotMatch(prompt, /分享什么|推进|巡检|最优|你是 Eden Agent/)
})
