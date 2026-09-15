import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'
import { SystemSkillCatalog } from '../../../src/modules/skills/index.ts'
import { capabilityFixture } from './fixture.ts'

function system(request: Record<string, unknown>) {
  return JSON.stringify((request.messages as { role: string; content: unknown }[]).filter(message => message.role === 'system'))
}

test('actual model requests receive summaries before reading, full instructions on demand, and an empty replacement after removal', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.install('echo-skill', 'PRIVATE_SKILL_BODY', ['unavailable_workflow_tool'])
  const model = await recordedModel([{ tool: 'list_skills', input: {} },
    { tool: 'load_skill', input: { name: 'echo-skill' } }, { text: '已读取说明' }, { text: '目录已更新' }])
  t.after(() => model.close())
  const runtime = createRuntime({ sessionId: f.session.id, systemPrompt: '', model: model.config, tools: f.capabilities().tools(),
    refreshTools: () => f.capabilities().tools(), callbacks: callbacks().handlers })
  await runtime.prompt('读取回显流程。')
  assert.match(system(model.requests[0]!), /echo-skill/)
  assert.match(system(model.requests[0]!), /unavailable_workflow_tool/)
  assert.doesNotMatch(system(model.requests[0]!), /PRIVATE_SKILL_BODY/)
  assert.match(JSON.stringify(model.requests[1]!.messages), /echo-skill/)
  assert.match(JSON.stringify(model.requests[2]!.messages), /PRIVATE_SKILL_BODY/)
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'unavailable_workflow_tool'))
  f.skills.uninstall('echo-skill')
  await runtime.prompt('现在有哪些技能？')
  assert.match(system(model.requests[3]!), /当前没有可供模型读取的技能条目/)
  assert.doesNotMatch(system(model.requests[3]!), /echo-skill/)
})

test('catalog refresh failure stays visible through the capability selector', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-skill-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let roots = [root]
  const catalog = new SystemSkillCatalog(() => roots)
  const f = await capabilityFixture(':memory:', catalog); t.after(() => f.close())
  roots = [path.join(root, 'missing')]
  await assert.rejects(f.service.refresh(), /ENOENT/)
  const hint = f.capabilities().tools().find(tool => tool.name === 'list_skills')!.promptHint!
  assert.match(hint, /技能目录刷新失败/)
  assert.match(hint, /空目录不能证明没有安装技能/)
  roots = [root]; await f.service.refresh()
  assert.doesNotMatch(f.capabilities().tools().find(tool => tool.name === 'list_skills')!.promptHint!, /刷新失败/)
})
