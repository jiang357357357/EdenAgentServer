import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityFixture, fixtureTool } from './fixture.ts'

test('loading by ID isolates failures, hides revisions and preserves global tools across workspaces', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.setTools([fixtureTool('list_contact_channels'), fixtureTool('get_esp32_command_status')])
  const capabilities = f.capabilities()
  assert.equal(capabilities.discover({ query: 'contact channel', offset: 0, limit: 20 }).tools[0]!.name, 'list_contact_channels')
  const result = capabilities.loadTools([{ id: 'builtin:missing' }, { id: 'builtin:get_esp32_command_status' }])
  assert.deepEqual(result.loaded, [{ id: 'builtin:get_esp32_command_status', name: 'get_esp32_command_status' }])
  assert.equal(result.failed.length, 1)
  assert.doesNotMatch(JSON.stringify(capabilities.discover({ query: 'esp32', offset: 0, limit: 20 })), /revision/)
  f.setWorkspace('/another-workspace')
  assert.ok(f.capabilities().tools().some(tool => tool.name === 'get_esp32_command_status'))
  f.setOwner('another-actor')
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'get_esp32_command_status'))
})

test('model tool and skill schemas omit internal snapshot parameters', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); f.install()
  const tools = f.capabilities().registry().tools
  for (const name of ['load_tools', 'load_skill', 'read_skill_file', 'unload_skill', 'run_skill_tool']) {
    assert.doesNotMatch(JSON.stringify(tools.find(tool => tool.name === name)!.parameters), /revision|expectedContentHash|expectedWorkspaceRoot/i)
  }
  const hint = f.capabilities().tools().find(tool => tool.name === 'list_skills')!.promptHint!
  assert.doesNotMatch(hint, /[a-f0-9]{64}/)
})

test('unloaded tools are discoverable from a live directory without loading skills or listing tools', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.setTools([{ ...fixtureTool('control_esp32_device'), description: '向设备发起电话。完整操作流程。' }])
  const scope = f.capabilities()
  const before = scope.tools()
  const directory = before.find(tool => tool.name === 'list_tools')!.promptHint!
  assert.match(directory, /builtin:control_esp32_device/)
  assert.match(directory, /向设备发起电话/)
  assert.doesNotMatch(directory, /完整操作流程/)
  assert.ok(!before.some(tool => tool.name === 'control_esp32_device'))
  assert.deepEqual(scope.loadTools([{ id: 'builtin:control_esp32_device' }]).failed, [])
  const after = scope.tools()
  assert.ok(after.some(tool => tool.name === 'control_esp32_device'))
  assert.doesNotMatch(after.find(tool => tool.name === 'list_tools')!.promptHint!, /builtin:control_esp32_device/)
  f.setTools([])
  assert.doesNotMatch(scope.tools().find(tool => tool.name === 'list_tools')!.promptHint!, /builtin:control_esp32_device/)
})
