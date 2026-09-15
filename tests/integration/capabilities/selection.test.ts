import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { SkillRepository } from '../../../src/modules/skills/index.ts'
import { SessionCapabilities } from '../../../src/modules/capabilities/index.ts'
import { capabilityFixture, fixtureTool } from './fixture.ts'

test('skills and professional tools stay deferred until loaded, then unload independently', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  const tool = fixtureTool(); f.setTools([tool]); f.install('echo-skill', '使用 echo_skill 和 special_action。', ['special_action'])
  const names = () => f.capabilities().tools().map(item => item.name)
  assert.ok(names().includes('load_skill'))
  assert.ok(!names().includes('read_skill'))
  assert.ok(!names().includes('special_action'))
  assert.ok(!names().includes('echo_skill'))
  const discovered = f.capabilities().discover({ query: 'special_action', offset: 0, limit: 20 }).tools[0]!
  assert.equal('parameters' in discovered, false)
  f.capabilities().loadTools([discovered])
  f.capabilities().loadSkill('echo-skill'); f.exposeEcho()
  assert.ok(names().includes('echo_skill'))
  f.capabilities().unloadTools([discovered.id])
  assert.ok(!names().includes('special_action'), 'tool exposure can be removed while instructions remain loaded')
  f.capabilities().unloadSkill('echo-skill')
  assert.ok(!names().includes('special_action'))
  assert.ok(names().includes('echo_skill'), 'unloading instructions preserves tool exposure')
  const echo = f.capabilities().discover({ query: 'echo_skill', offset: 0, limit: 20 }).tools[0]!
  f.capabilities().unloadTools([echo.id])
  assert.ok(!names().includes('echo_skill'))
  f.capabilities().loadTools([echo])
  assert.ok(names().includes('echo_skill'))
})

test('actor, workspace and revisions isolate selections and stale definitions cannot execute', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.install(); f.capabilities().loadSkill('echo-skill'); f.exposeEcho()
  const old = f.capabilities().tools().find(tool => tool.name === 'echo_skill')!
  f.setOwner('another-actor')
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  f.setOwner('')
  f.setWorkspace('/different-workspace')
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  f.setWorkspace('')
  f.install('echo-skill', '说明已更新。')
  assert.equal(f.capabilities().discover({ query: '', offset: 0, limit: 20 }).selections[0]!.status, 'stale')
  assert.throws(() => old.resolveCall!({ text: 'stale' }), /changed|loaded/)
  f.capabilities().loadTools(f.capabilities().discover({ query: 'echo_skill', offset: 0, limit: 20 }).tools)
  assert.ok(f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  assert.equal(f.capabilities().discover({ query: '', offset: 0, limit: 20 }).selections.find(item => item.kind === 'skill')!.status, 'stale')
})

test('generic forwarding must resolve to a loaded final target', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.install()
  const generic = f.capabilities().discover({ query: 'run_skill_tool', offset: 0, limit: 20 }).tools[0]!
  f.capabilities().loadTools([generic])
  const dispatcher = () => f.capabilities().tools().find(tool => tool.name === 'run_skill_tool')!
  const input = { name: 'echo-skill', tool: 'echo_skill', arguments: { text: 'hello' } }
  assert.throws(() => dispatcher().resolveCall!(input), /not loaded/)
  f.capabilities().loadSkill('echo-skill'); f.exposeEcho()
  assert.equal(dispatcher().resolveCall!(input).tool.name, 'echo_skill')
  f.capabilities().unloadSkill('echo-skill')
  assert.equal(dispatcher().resolveCall!(input).tool.name, 'echo_skill')
  f.capabilities().unloadTools(['skill:echo-skill:echo_skill'])
  assert.throws(() => dispatcher().resolveCall!(input), /not loaded/)
})

test('manual selections survive database reopening and do not restore changed versions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-capability-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = path.join(root, 'test.sqlite'), f = await capabilityFixture(filename)
  const sessionId = f.session.id, tool = fixtureTool()
  f.setTools([tool])
  f.capabilities().loadTools(f.capabilities().discover({ query: 'special_action', offset: 0, limit: 20 }).tools)
  await f.close()
  const db = new EdenDatabase(filename, 'local'), sessions = new SessionRepository(db, 'local')
  t.after(() => db.close())
  const scope = () => ({ sessionId, owner: '', workspaceRoot: '', profile: 'user_chat' })
  const restored = new SessionCapabilities(db, sessions.events, new SkillRepository(db), scope, () => [tool])
  assert.ok(restored.tools().some(item => item.name === tool.name))
  tool.revision = '2'
  assert.ok(!restored.tools().some(item => item.name === tool.name))
  assert.equal(restored.discover({ query: '', offset: 0, limit: 20 }).selections[0]!.status, 'stale')
})
