import test from 'node:test'
import assert from 'node:assert/strict'
import { narrowPolicy, rolePolicy } from '../src/modules/subagent-execution/tool-policy.ts'
import { historicalContextSources } from '../src/modules/sessions/context-sources.ts'
import { sessionPromptContent } from '../src/modules/sessions/turn/session-prompt.ts'
import { subagentRoleDefinitionSchema } from '@eden/api'

test('current builtin names preserve deny and allow restrictions while narrowing policies', () => {
  const parent = { sandboxMode: 'inherit' as const, allowedTools: ['read_file', 'exec_command'], deniedTools: ['exec_command'], instructions: '' }
  const child = { ...parent, allowedTools: ['read_file', 'exec_command'], deniedTools: [] }
  const original = JSON.stringify(parent)
  const result = narrowPolicy(parent, child)
  assert.deepEqual(result.allowedTools, ['read_file', 'exec_command'])
  assert.deepEqual(result.deniedTools, ['exec_command'])
  assert.equal(JSON.stringify(parent), original)
  const role = rolePolicy('test', { ...parent, sandboxMode: 'read-only', name: 'test' } as Parameters<typeof rolePolicy>[1])
  assert.deepEqual(role.allowedTools, ['read_file'])
  assert.ok(role.deniedTools.includes('exec_command'))
})
test('context classification recognizes the current attachment tool prompt', () => {
  const prompt = sessionPromptContent({ participants: [{ assistantId: 21 }] }).prompt
  const snapshot = { payload: { messages: [{ role: 'system', content: prompt }] } }
  const recovered = historicalContextSources(snapshot) as Record<string, any>
  assert.deepEqual(recovered.payload, snapshot.payload)
  assert.ok(recovered.contextSources.some((source: any) => source.kind === 'character'))
})
test('new subagent role policies reject the retired project prefix', () => {
  assert.throws(() => subagentRoleDefinitionSchema.parse({
    name: 'invalid', description: 'invalid', instructions: 'invalid', skills: [], model: null, reasoning: null,
    sandboxMode: 'inherit', allowedTools: ['eden_custom'], deniedTools: [], maxTurns: 1,
  }), /前缀的工具名称已经停用/)
})
