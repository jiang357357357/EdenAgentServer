import assert from 'node:assert/strict'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { PluginService } from '@eden/plugin-host'
import { memoTools } from '../../../src/modules/memos/tools.ts'
import { MemoRepository } from '../../../src/modules/memos/repository.ts'
import { subagentTools } from '../../../src/modules/subagents/tools.ts'
import type { SubagentService } from '../../../src/modules/subagents/service.ts'
import { pluginTools } from '../../../src/modules/plugins/plugin-tools.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'

test('memo model parameters exclude delivery state and metadata; reminder kind is inferred', async t => {
  const db = new EdenDatabase(':memory:', 'local'); t.after(() => db.close())
  const sessions = new SessionRepository(db, 'local'), session = sessions.create('Model parameters')
  const permissions = new PermissionService(db, sessions.events); permissions.setMode('takeover')
  const tools = memoTools(new MemoRepository(db), permissions, session.id, session.id)
  assert.ok(!tools.some(tool => ['mark_memo_triggered', 'dispatch_due_memos'].includes(tool.name)))
  for (const name of ['create_memo', 'create_reminder', 'update_memo']) {
    assert.doesNotMatch(JSON.stringify(tools.find(tool => tool.name === name)!.parameters), /metadata/)
  }
  const reminder = tools.find(tool => tool.name === 'create_reminder')!
  assert.doesNotMatch(JSON.stringify(reminder.parameters), /"kind"/)
  const result = await reminder.execute({ title: '测试', remindAt: Date.now() + 60000 }, { callId: 'memo', signal: new AbortController().signal })
  assert.equal((result as { kind: string }).kind, 'reminder')
  const spawn = subagentTools({} as SubagentService, permissions, session.id, session.id)[0]!
  assert.deepEqual(Object.keys(spawn.parameters.properties as object).sort(), ['message', 'role', 'taskName'])
})

test('plugin edits use host snapshots and reject changes made while approval is pending', async t => {
  const db = new EdenDatabase(':memory:', 'local'); t.after(() => db.close())
  const sessions = new SessionRepository(db, 'local'), session = sessions.create('Draft conflict')
  const plugins = new PluginService(db), permissions = new PermissionService(db, sessions.events)
  const manifest = { schemaVersion: 1, id: 'echo', name: 'Echo', description: 'Echo', version: '1.0.0', entry: 'index.ts',
    tool: { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: {} } }, permissions: [], tests: [{ input: {}, expected: 1 }] }
  const original = plugins.drafts.save(manifest, 'export default () => 1')
  const tool = pluginTools(plugins, permissions, session.id, session.id)[0]!
  const context = { callId: 'edit', signal: new AbortController().signal }
  const read = await tool.execute({ action: 'read', args: { id: 'echo' } }, context)
  assert.doesNotMatch(JSON.stringify(read), /draftRevision/)
  const pending = tool.execute({ action: 'draft', args: { manifest, source: 'export default () => 2' } }, context)
  const rejected = assert.rejects(pending, /draft changed/)
  plugins.drafts.save(manifest, 'export default () => 3', original.draftRevision)
  const otherActor = pluginTools(plugins, permissions, session.id, session.id, 'other')[0]!
  await otherActor.execute({ action: 'read', args: { id: 'echo' } }, { ...context, callId: 'other-read' })
  permissions.resolve(permissions.list().find(item => item.state === 'pending')!.id, true)
  await rejected
  assert.equal(plugins.drafts.read('echo').source, 'export default () => 3')
})
