import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { capabilityFixture, fixtureTool } from './fixture.ts'

test('legacy skill tool bindings migrate to independent selections and survive instruction unloading', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-independent-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = path.join(root, 'test.sqlite'), f = await capabilityFixture(filename)
  f.setTools([fixtureTool()]); f.install('echo-skill', '使用回显工具。', ['special_action'])
  f.capabilities().loadSkill('echo-skill'); f.exposeEcho()
  const sessionId = f.session.id, db = f.database.connection
  // Model the previous schema: skill bindings owned exposure, even after a manual unload.
  f.capabilities().loadTools(f.capabilities().discover({ query: 'special_action', offset: 0, limit: 20 }).tools)
  f.capabilities().unloadTools(['builtin:special_action'])
  db.prepare("DELETE FROM session_capability_selections WHERE kind='tool' AND key<>?").run('builtin:special_action')
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
  db.prepare('DELETE FROM schema_migrations WHERE version=?').run(version)
  db.exec(`PRAGMA user_version=${version - 1}`)
  await f.close()
  const restored = await capabilityFixture(filename)
  t.after(() => restored.close())
  const rows = restored.database.connection.prepare('SELECT kind,key,selection_json FROM session_capability_selections WHERE session_id=?').all(sessionId)
  const tools = rows.filter(row => row.kind === 'tool').map(row => JSON.parse(String(row.selection_json)))
  assert.deepEqual(tools.map(tool => tool.key).sort(), ['builtin:special_action', 'skill:echo-skill:echo_skill'])
  assert.ok(tools.every(tool => tool.enabled))
  assert.ok(tools.every(tool => tool.contextRoot === '' && tool.workspaceRoot === ''))
  // Use the old session's selection owner after reopening the real database.
  const { SessionCapabilities } = await import('../../../src/modules/capabilities/index.ts')
  const scope = new SessionCapabilities(restored.database, restored.sessions.events, restored.skills,
    () => ({ sessionId, owner: '', profile: 'user_chat', workspaceRoot: '' }), () => restored.capabilities().registry().tools.filter(tool => !['list_tools', 'load_tools', 'unload_tools'].includes(tool.name)))
  restored.setTools([fixtureTool()])
  scope.unloadSkill('echo-skill')
  assert.ok(scope.tools().some(tool => tool.name === 'echo_skill'))
  assert.ok(scope.tools().some(tool => tool.name === 'special_action'))
})
