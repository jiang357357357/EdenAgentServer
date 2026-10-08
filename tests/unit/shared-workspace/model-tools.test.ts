import assert from 'node:assert/strict'
import test from 'node:test'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { sharedFile, sharedModelFixture } from './model-tools-fixture.ts'
import { searchTools } from '../../../src/modules/capabilities/tool-search.ts'
import { defaultTool, ToolRegistry } from '../../../src/modules/capabilities/index.ts'
import { rolePolicy } from '../../../src/modules/subagent-execution/tool-policy.ts'

test('shared status reports a synced empty receiver honestly without requiring publisher DLC', async t => {
  const f = sharedModelFixture(t), status = await f.call('status')
  assert.equal(status.directory.path, f.first)
  assert.equal(f.workspace.forSession(f.a.id).root(), f.project)
  assert.equal(status.shared.available, true); assert.equal(status.shared.bound, true)
  assert.equal(status.shared.canPublish, false)
  assert.match(status.guidance, /空库也可以已同步/)
  const files = await f.call('files')
  assert.deepEqual(files.files, []); assert.equal(files.total, 0)
  assert.equal(files.shared.lastSync, 1)
  assert.deepEqual(f.mutations, [])
})

test('library queries paginate authorized metadata and strip credential-shaped extra fields', async t => {
  const f = sharedModelFixture(t)
  f.spaces.push({ ...f.spaces[0]!, name: '另一个项目' })
  const page = await f.call('spaces', { limit: 1 })
  assert.equal(page.total, 2); assert.equal(page.nextOffset, 1)
  assert.equal(page.spaces[0].name, '项目资料')
  assert.equal((await f.call('spaces', { query: '另一个' })).spaces.length, 1)
  assert.doesNotMatch(JSON.stringify(page), /must-not-expose|fixture-private-token/)
  assert.ok(f.requests.every(request => request.startsWith('GET ')))
  assert.deepEqual(f.mutations, [])
})

test('file queries use the independent shared directory across sessions and distinguish deleted records', async t => {
  const f = sharedModelFixture(t)
  f.index.set(f.first, [sharedFile('资料/b.txt'), sharedFile('资料/a.txt'), sharedFile('资料/deleted.txt', true)])
  f.index.set(f.second, [sharedFile('其他会话秘密.txt')])
  const page = await f.call('files', { query: '资料', limit: 1 })
  assert.equal(page.files[0].path, '资料/a.txt'); assert.equal(page.nextOffset, 1); assert.equal(page.total, 2)
  const last = await f.call('files', { offset: 1, limit: 1 })
  assert.equal(last.files[0].path, '资料/b.txt'); assert.equal(last.nextOffset, null)
  assert.equal((await f.call('files', { includeDeleted: true })).total, 3)
  assert.equal((await f.call('files', {}, f.b.id)).files[0].path, '资料/a.txt')
  f.service.selectDirectory(f.a.id, f.second, f.service.directory(f.a.id).revision)
  assert.equal((await f.call('files', {}, f.a.id)).files[0].path, '其他会话秘密.txt')
  assert.equal(f.workspace.forSession(f.a.id).root(), f.project)
  assert.doesNotMatch(JSON.stringify(page), /其他会话秘密/)
  assert.equal(page.source, 'synchronized-file-index')
})

test('offline cached indexes remain readable and unbound states cannot expose an old index', async t => {
  const f = sharedModelFixture(t)
  f.index.set(f.first, [sharedFile('离线文件.txt')]); f.states.set(f.first, { state: 'offline' })
  const offline = await f.call('files')
  assert.equal(offline.shared.state, 'offline'); assert.equal(offline.total, 1)
  f.states.set(f.first, { state: 'unbound', bound: false, spaceId: null, lastSync: null })
  const unbound = await f.call('files')
  assert.equal(unbound.shared.bound, false); assert.deepEqual(unbound.files, [])
})

test('model schemas reject scope overrides and mutating instructions before accessing services', async t => {
  const f = sharedModelFixture(t)
  for (const action of ['status', 'spaces', 'files'] as const) {
    for (const input of [{ sessionId: f.b.id }, { expectedWorkspacePath: f.second }, { spaceId: f.spaces[0]!.id }, { action: 'bind' }])
      await assert.rejects(f.call(action, input))
  }
  assert.deepEqual(f.requests, []); assert.deepEqual(f.mutations, [])
  for (const tool of f.tools()) assert.doesNotMatch(JSON.stringify(tool.parameters), /sessionId|spaceId|expectedWorkspacePath|revision/)
})

test('one shared query tool requires an explicit read action and validates each action before service access', async t => {
  const f = sharedModelFixture(t), [tool] = f.tools()
  assert.equal(f.tools().length, 1); assert.equal(tool!.name, 'query_shared_workspace')
  assert.equal(tool!.parameters.type, 'object'); assert.equal(tool!.parameters.additionalProperties, false)
  assert.deepEqual(tool!.parameters.required, ['action'])
  for (const input of [{}, { action: 'create' }, { action: 'status', query: '资料' }, { action: 'status', offset: 0 },
    { action: 'status', limit: 1 }, { action: 'status', includeDeleted: false }, { action: 'spaces', includeDeleted: true },
    { action: 'files', limit: 201 }, { action: 'files', offset: -1 }, { action: 'files', query: 'x'.repeat(201) }])
    await assert.rejects(tool!.execute(input, { callId: 'invalid', signal: new AbortController().signal }))
  assert.deepEqual(f.requests, []); assert.deepEqual(f.mutations, [])
})

test('rebinding during a file query returns one coherent current binding and hides an unbound index', async t => {
  const f = sharedModelFixture(t), folder = f.service.forSession(f.a.id), perform = folder.perform.bind(folder)
  folder.perform = async (root, work) => {
    f.states.set(f.first, { spaceId: f.spaces[0]!.id + '-changed' })
    f.index.set(f.first, [sharedFile('新绑定文件.txt')])
    return perform(root, work)
  }
  const changed = await f.call('files')
  assert.equal(changed.shared.spaceId, f.spaces[0]!.id + '-changed')
  assert.equal(changed.files[0].path, '新绑定文件.txt')
  folder.perform = async (root, work) => {
    f.states.set(f.first, { spaceId: null, bound: false, state: 'unbound' })
    return perform(root, work)
  }
  const unbound = await f.call('files')
  assert.equal(unbound.shared.bound, false); assert.deepEqual(unbound.files, [])
})

test('an unselected current workspace does not block or adopt the independent shared directory', async t => {
  const f = sharedModelFixture(t)
  f.database.connection.prepare('INSERT INTO session_workspaces(session_id,settings_json,updated_at) VALUES(?,?,?)')
    .run(f.a.id, '{}', 1)
  f.database.connection.prepare("DELETE FROM runtime_settings WHERE key LIKE 'workspace.%'").run()
  const { SharedWorkspaceModelQuery } = await import('../../../src/modules/shared-workspace/model-query.ts')
  const { WorkspaceService } = await import('../../../src/modules/workspace/index.ts')
  const workspace = new WorkspaceService(f.database, [])
  const query = new SharedWorkspaceModelQuery(f.service, f.a.id)
  const result = await query.status(new AbortController().signal) as { directory: { path: string }; shared: { bound: boolean } }
  assert.equal(workspace.forSession(f.a.id).info().status, 'unselected')
  assert.equal(result.directory.path, f.first); assert.equal(result.shared.bound, true)
  assert.equal(workspace.forSession(f.a.id).info().status, 'unselected')
})

test('foreign and deleted sessions are rejected before any shared metadata is read', async t => {
  const f = sharedModelFixture(t), stranger = { ...f.account, userId: '2', key: accountKey(f.account.coreBaseUrl, '2') }
  await assert.rejects(withAccount(stranger, () => f.call('status')), /不属于当前账号/)
  f.sessions.setStatus(f.a.id, 'deleted')
  await assert.rejects(f.call('files'), /Session not found/)
  assert.deepEqual(f.requests, [])
})

test('switching away and back during a metadata request discards its stale result', async t => {
  const f = sharedModelFixture(t)
  let started!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve }), pending = new Promise<void>(resolve => { release = resolve })
  f.hold(async () => { started(); await pending })
  const operation = f.call('spaces'), rejection = assert.rejects(operation, /共享目录.*变化/)
  await entered
  f.service.selectDirectory(f.a.id, f.second, f.service.directory(f.a.id).revision)
  f.service.selectDirectory(f.a.id, f.first, f.service.directory(f.a.id).revision)
  release(); await rejection
})

test('cancellation rejects queries before network reads and shared status cannot return a mismatched root', async t => {
  const f = sharedModelFixture(t), controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(f.call('files', {}, f.a.id, controller.signal), /cancelled/)
  assert.deepEqual(f.requests, [])
  f.states.set(f.first, { root: f.second })
  await assert.rejects(f.call('status'), /共享目录状态已改变/)
})

test('a deleted session cannot receive an in-flight shared-library metadata result', async t => {
  const f = sharedModelFixture(t)
  f.hold(async () => { f.sessions.setStatus(f.a.id, 'deleted') })
  await assert.rejects(f.call('spaces'), /Session not found/)
})

test('shared queries are discoverable by library keywords, exposed by default and admitted by read-only role policy', t => {
  const f = sharedModelFixture(t), tools = new ToolRegistry(f.tools()).tools
  for (const word of ['资料库', '共享库', 'shared workspace']) assert.equal(searchTools(tools, word).length, 1)
  for (const tool of tools) assert.equal(defaultTool(tool, 'user_chat', true), true)
  const allowed = rolePolicy('researcher').allowedTools
  for (const tool of tools) assert.ok(allowed?.includes(tool.name))
  assert.match(tools[0]!.promptHint!, /read_shared_file/)
})
