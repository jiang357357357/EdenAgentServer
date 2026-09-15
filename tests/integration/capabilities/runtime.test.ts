import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'
import { capabilityFixture } from './fixture.ts'

test('one live model turn loads skill instructions, runs its real code and retains its schema after unloading instructions', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); f.install()
  const echo = f.capabilities().discover({ query: 'echo_skill', offset: 0, limit: 20 }).tools[0]!
  const model = await recordedModel([{ tool: 'load_skill', input: { name: 'echo-skill' } },
    { tool: 'load_tools', input: { tools: [{ id: echo.id }] } },
    { tool: 'echo_skill', input: { text: 'hello' } }, { tool: 'unload_skill', input: { name: 'echo-skill' } }, { text: '完成' }])
  t.after(() => model.close())
  const audit = callbacks(), operations: string[] = []
  const runtime = createRuntime({ sessionId: f.session.id, systemPrompt: '', model: model.config, tools: f.capabilities().tools(),
    refreshTools: () => f.capabilities().tools(), callbacks: { ...audit.handlers, async beforeTool(name) { operations.push(name) } } })
  await runtime.prompt('加载回显技能，执行后卸载。')
  const names = (index: number) => (model.requests[index]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  assert.match(JSON.stringify(model.requests[0]!.messages), /skill:echo-skill:echo_skill/)
  assert.ok(!names(0).includes('echo_skill'))
  assert.ok(!names(1).includes('echo_skill'))
  assert.ok(names(2).includes('echo_skill'))
  assert.ok(names(4).includes('echo_skill'))
  assert.deepEqual(operations, ['load_skill', 'load_tools', 'echo_skill', 'unload_skill'])
  assert.match(JSON.stringify(model.requests[3]!.messages), /hello/)
  assert.equal(f.permissions.list().filter(item => item.capability === 'skill.execute').length, 1)
})

test('approval cannot execute a capability unloaded during the wait', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); f.install()
  f.capabilities().loadSkill('echo-skill'); f.exposeEcho(); f.permissions.setMode('restricted')
  const tool = f.capabilities().tools().find(item => item.name === 'echo_skill')!
  const resolved = tool.resolveCall!({ text: 'should not execute' })
  const pending = resolved.tool.execute(resolved.input, { callId: 'approval', signal: new AbortController().signal, assertCurrent: resolved.tool.assertCurrent! })
  const rejected = assert.rejects(pending, /not loaded/)
  const request = f.permissions.list().find(item => item.state === 'pending')!
  f.capabilities().unloadTools(['skill:echo-skill:echo_skill'])
  f.permissions.resolve(request.id, true)
  await rejected
})


test('a skill code tool executes across turns without reading instructions or requiring unrelated workflow dependencies', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.install('echo-skill', '回显后再执行其他流程。', ['unavailable_workflow_tool'])
  const echo = f.capabilities().discover({ query: 'echo_skill', offset: 0, limit: 20 }).tools[0]!
  const model = await recordedModel([{ tool: 'load_tools', input: { tools: [{ id: echo.id }] } },
    { tool: 'echo_skill', input: { text: 'first' } }, { text: '完成' },
    { tool: 'echo_skill', input: { text: 'second' } }, { text: '再次完成' }])
  t.after(() => model.close())
  const audit = callbacks(), operations: string[] = []
  const runtime = createRuntime({ sessionId: f.session.id, systemPrompt: '', model: model.config, tools: f.capabilities().tools(),
    refreshTools: () => f.capabilities().tools(), callbacks: { ...audit.handlers, async beforeTool(name) { operations.push(name) } } })
  await runtime.prompt('加载回显工具并执行。')
  await runtime.prompt('再次执行回显工具。')
  assert.deepEqual(operations, ['load_tools', 'echo_skill', 'echo_skill'])
  assert.match(JSON.stringify(model.requests.at(-1)!.messages), /second/)
  assert.ok(!f.capabilities().discover({ query: '', offset: 0, limit: 20 }).selections.some(item => item.kind === 'skill'))
  assert.equal(f.permissions.list().filter(item => item.capability === 'skill.execute').length, 2)
})
