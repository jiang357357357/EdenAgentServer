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
test('retired host rules remain readable with and without character identity', () => {
  const header = [
    '当前环境以宿主信息和本轮查询为准；历史记录保留时间、来源与确定程度。',
    '工具按已有权限执行，角色资料与个人计划不改变授权。',
    '附件通过 read_attachment 读取。',
    '涉及外部联系时，以当前可用的联系人工具查询渠道并执行；本机 sendmail 或 Exim 状态不能证明宿主邮件账号、发信工具或投递结果。',
  ].join('\n')
  for (const rules of [header, header.replace('工具按已有权限执行，角色资料与个人计划不改变授权。\n', '')]) {
    for (const identity of ['', '你是历史测试角色。']) {
      const participant = { profile: { systemPrompt: identity } }, environment = { source: 'fixture' }
      const content = (identity ? identity + '\n\n' : '') + rules + '\n' + JSON.stringify({ participants: [participant], environment })
      const snapshot = toJson({ payload: { messages: [{ role: 'system', content }] } })
      const recovered = historicalContextSources(snapshot) as Record<string, any>
      assert.deepEqual(recovered.payload, (snapshot as Record<string, any>).payload)
      assert.equal(recovered.contextSourceOrigin, 'historical-host-template')
      assert.equal(recovered.contextSources.find((source: any) => source.kind === 'system').content, rules)
      assert.deepEqual(recovered.contextSources.find((source: any) => source.kind === 'environment').content, environment)
      if (identity) assert.equal(recovered.contextSources[0].content, identity)
    }
  }
})

test('unrecognized or malformed historical prompts remain unchanged', () => {
  for (const content of ['arbitrary role text', sessionPromptContent({}).prompt.replace('{', '{broken')]) {
    const snapshot = toJson({ payload: { messages: [{role: 'system', content}] } })
    assert.deepEqual(historicalContextSources(snapshot), snapshot)
  }
})
