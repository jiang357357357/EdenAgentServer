import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionCapabilities } from '../../../src/modules/capabilities/index.ts'
import { capabilityFixture, fixtureTool } from '../../integration/capabilities/fixture.ts'

test('catalog visibility reads scope independently of tool count and revalidates later workspace changes', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  let reads = 0, workspaceRoot = '/synthetic-workspace'
  const definitions = [fixtureTool('read_file'), ...Array.from({ length: 120 }, (_, i) => fixtureTool(`deferred_${i}`))]
  const capabilities = new SessionCapabilities(f.database, f.sessions.events, f.skills, () => {
    reads++
    return { sessionId: f.session.id, owner: 'character', profile: 'user_chat', workspaceRoot }
  }, () => definitions)
  const tool = capabilities.tools().find(value => value.name === 'read_file')!
  assert.ok(tool)
  assert.ok(reads < 20, `Scope was rebuilt ${reads} times for one catalog`)
  capabilities.loadTools(Array.from({ length: 30 }, (_, i) => ({ id: `deferred_${i}` })))
  reads = 0
  assert.ok(capabilities.tools().length >= 31)
  assert.ok(reads < 20, `Loaded selections rebuilt scope ${reads} times`)
  const resolved = tool.resolveCall!({})
  resolved.tool.assertCurrent!()
  const previous = reads
  workspaceRoot = ''
  assert.throws(() => resolved.tool.assertCurrent!(), /not loaded/)
  assert.ok(reads > previous)
})
