import test from 'node:test'
import assert from 'node:assert/strict'
import { toJson } from '@eden/api'
import { historicalContextSources } from '../src/modules/sessions/context-sources.ts'
import { sessionPromptContent } from '../src/modules/sessions/turn/session-prompt.ts'
import { actorSystemContent } from '../src/modules/actors/actor-prompt.ts'

test('historical host formats recover actual embedded profile, environment, memory and skill hints', () => {
  const participant = { assistantId: 21, profile: { personality: 'fixture' } }
  for (const context of [sessionPromptContent({ participants: [participant] }), actorSystemContent(participant, {})]) {
    const memory = '\n# 相关长期记忆\nfixture memory', hint = 'fixture skills'
    const snapshot = toJson({ payload: { messages: [{ role: 'system', content: context.prompt + memory + '\n\n' + hint }] }, promptHints: [{ name: 'list_skills', text: hint }] })
    const recovered = historicalContextSources(snapshot) as Record<string, any>
    assert.deepEqual(recovered.payload, (snapshot as Record<string, any>).payload)
    assert.ok(recovered.contextSources.some((s: any) => s.kind === 'character' && JSON.stringify(s.content).includes('fixture')))
    assert.equal(recovered.contextSources.find((s: any) => s.kind === 'memory').content, memory)
    assert.equal(recovered.contextSources.find((s: any) => s.kind === 'skills').content, hint)
    assert.deepEqual(historicalContextSources(recovered), recovered)
  }
})
test('unrecognized or malformed historical prompts remain unchanged', () => {
  for (const content of ['arbitrary role text', sessionPromptContent({}).prompt.replace('{', '{broken')]) {
    const snapshot = toJson({ payload: { messages: [{role: 'system', content}] } })
    assert.deepEqual(historicalContextSources(snapshot), snapshot)
  }
})
