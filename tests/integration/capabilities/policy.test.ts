import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityFixture, fixtureTool } from './fixture.ts'
import { capabilityOwner } from '../../../src/modules/capabilities/index.ts'

test('single and multi-actor scopes agree and switching the assistant changes capability ownership', () => {
  assert.equal(capabilityOwner([{ assistantId: 1 }]), '1')
  assert.equal(capabilityOwner([{ assistantId: 1 }, { assistantId: 2 }], 1), '1')
  assert.notEqual(capabilityOwner([{ assistantId: 1 }]), capabilityOwner([{ assistantId: 2 }]))
  assert.notEqual(capabilityOwner([{ assistantId: -1, characterId: 1 }]), capabilityOwner([{ assistantId: -1, characterId: 2 }]))
})

test('generic invocation cannot evade a denied final skill and root-only names stay excluded', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); f.install(); f.setProfile('subagent')
  const parent = f.sessions.create('parent'), db = f.database.connection
  db.prepare(`INSERT INTO subagent_threads(id,root_session_id,parent_session_id,child_session_id,agent_path,task_name,role,depth,state,operation_key,created_at,updated_at,workspace_root)
    VALUES('child',?,?,?,'/root/child','child','worker',1,'completed','fixture',1,1,'')`).run(parent.id, parent.id, f.session.id)
  const save = (deniedTools: string[]) => db.prepare('INSERT OR REPLACE INTO subagent_policies VALUES(?,?,1)')
    .run('child', JSON.stringify({ sandboxMode: 'inherit', allowedTools: null, deniedTools, instructions: '' }))
  save([])
  f.setTools([fixtureTool('switch_assistant')])
  assert.ok(!f.capabilities().discover({ query: 'switch_assistant', offset: 0, limit: 20 }).tools.length)
  f.capabilities().loadSkill('echo-skill'); f.exposeEcho()
  f.capabilities().loadTools(f.capabilities().discover({ query: 'run_skill_tool', offset: 0, limit: 20 }).tools)
  const wrapper = f.capabilities().tools().find(tool => tool.name === 'run_skill_tool')!
  save(['echo_skill'])
  assert.throws(() => wrapper.resolveCall!({ name: 'echo-skill', tool: 'echo_skill', arguments: { text: 'blocked' } }), /不可用|excluded|unavailable/)
  assert.doesNotMatch(f.capabilities().tools().find(tool => tool.name === 'list_tools')!.promptHint!, /skill:echo-skill:echo_skill|builtin:switch_assistant/)
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  const loaded = f.capabilities().loadSkill('echo-skill')
  assert.deepEqual(loaded.missingTools, ['echo_skill'])
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
})

test('role skill preloading validates its saved snapshot and explicit unloading persists', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); const installed = f.install(); f.setProfile('subagent')
  const parent = f.sessions.create('parent'), db = f.database.connection
  db.prepare(`INSERT INTO subagent_threads(id,root_session_id,parent_session_id,child_session_id,agent_path,task_name,role,depth,state,operation_key,created_at,updated_at,workspace_root)
    VALUES('child',?,?,?,'/root/child','child','worker',1,'completed','fixture',1,1,'')`).run(parent.id, parent.id, f.session.id)
  db.prepare('INSERT INTO subagent_role_snapshots VALUES(?,?,?,1)').run('child', '{}', JSON.stringify([
    { name: installed.name, contentHash: installed.contentHash, workspaceRoot: installed.workspaceRoot },
  ]))
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  f.exposeEcho()
  f.capabilities().unloadSkill('echo-skill')
  assert.ok(f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  f.capabilities().unloadTools(['skill:echo-skill:echo_skill'])
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
})
