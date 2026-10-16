import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'
import { sharedLibraryFileTools } from '../../../src/modules/shared-workspace/index.ts'
import { SharedDirectorySelection } from '../../../src/modules/shared-workspace/directory-selection.ts'
import { builtinSkillSnapshots } from '../../../src/modules/skills/index.ts'
import { rolePolicy } from '../../../src/modules/subagent-execution/tool-policy.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { sharedModelFixture } from './model-tools-fixture.ts'

function fileFixture(t: Parameters<typeof sharedModelFixture>[0]) {
  const f = sharedModelFixture(t), requests: { capability: string; resource: string; details: unknown }[] = []
  f.spaces[0]!.role = 'editor'
  let beforeApproval = async () => {}, denial = false
  const permissions = { async request(_context: unknown, capability: string, resource: string, details: unknown) {
    requests.push({ capability, resource, details }); await beforeApproval()
    if (denial) throw new Error('Permission denied')
  } } as unknown as PermissionService
  const tools = (actor = 'main', turn = 'turn') => sharedLibraryFileTools(f.service, permissions, f.a.id, turn, actor)
  const catalog = tools()
  const call = (name: string, input: unknown, chosen = catalog, signal = new AbortController().signal) =>
    chosen.find(tool => tool.name === name)!.execute(input as Parameters<RuntimeTool['execute']>[0], { callId: randomUUID(), signal }) as Promise<any>
  return { ...f, call, tools, requests, hook: (work: () => Promise<void>) => { beforeApproval = work }, deny: () => { denial = true } }
}

test('shared skill reads, writes and edits a separate same-named file while project selection and content stay intact', async t => {
  const f = fileFixture(t)
  writeFileSync(path.join(f.project, 'note.txt'), 'project only')
  writeFileSync(path.join(f.first, 'note.txt'), 'shared original')
  assert.equal((await f.call('read_shared_file', { path: 'note.txt' })).content, 'shared original')
  const written = await f.call('write_shared_file', { path: 'note.txt', content: 'shared replacement' })
  assert.equal(written.sharedDirectory, f.first); assert.equal(written.synchronized, false)
  await f.call('edit_shared_file', { path: 'note.txt', oldText: 'replacement', newText: 'edited' })
  assert.equal(readFileSync(path.join(f.first, 'note.txt'), 'utf8'), 'shared edited')
  assert.equal(readFileSync(path.join(f.project, 'note.txt'), 'utf8'), 'project only')
  assert.equal(f.workspace.forSession(f.a.id).root(), f.project)
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every(request => request.capability === 'shared_workspace.write' && request.resource === path.join(f.first, 'note.txt')))
  mkdirSync(path.join(f.first, 'nested'))
  await f.call('write_shared_file', { path: 'nested/new.txt', content: 'new shared file', createOnly: true })
  assert.equal(readFileSync(path.join(f.first, 'nested/new.txt'), 'utf8'), 'new shared file')
  assert.equal(existsSync(path.join(f.project, 'nested/new.txt')), false)
})

test('project switches during approvals cannot redirect shared writes or invalidate shared queries', async t => {
  const f = fileFixture(t)
  f.hook(async () => { f.workspace.forSession(f.a.id).switch(f.second) })
  await f.call('write_shared_file', { path: 'new.txt', content: 'independent' })
  assert.equal(readFileSync(path.join(f.first, 'new.txt'), 'utf8'), 'independent')
  assert.equal(existsSync(path.join(f.second, 'new.txt')), false)
  assert.equal(f.workspace.forSession(f.a.id).root(), f.second)
  f.hold(async () => { f.workspace.forSession(f.a.id).switch(f.project) })
  assert.equal((await f.call('read_shared_file', { path: 'new.txt' })).content, 'independent')
  assert.ok((await f.service.forSession(f.a.id).spaces(f.first)))
  assert.equal(f.workspace.forSession(f.a.id).root(), f.project)
})

test('shared file reading and writing work with no current project selected and do not select one', async t => {
  const f = fileFixture(t)
  f.database.connection.prepare('INSERT INTO session_workspaces(session_id,settings_json,updated_at) VALUES(?,?,?)').run(f.a.id, '{}', 1)
  f.database.connection.prepare("DELETE FROM runtime_settings WHERE key LIKE 'workspace.%'").run()
  const project = new WorkspaceService(f.database, []).forSession(f.a.id)
  assert.equal(project.info().status, 'unselected')
  await f.call('write_shared_file', { path: 'independent.txt', content: 'no project needed' })
  assert.equal((await f.call('read_shared_file', { path: 'independent.txt' })).content, 'no project needed')
  assert.equal(project.info().status, 'unselected')
  assert.equal(existsSync(path.join(f.project, 'independent.txt')), false)
})

test('read-only members may read but cannot write or request a write approval', async t => {
  const f = fileFixture(t); f.spaces[0]!.role = 'viewer'
  writeFileSync(path.join(f.first, 'read.txt'), 'viewer readable')
  assert.equal((await f.call('read_shared_file', { path: 'read.txt' })).content, 'viewer readable')
  await assert.rejects(f.call('write_shared_file', { path: 'read.txt', content: 'forbidden' }), /只有读取权限/)
  await assert.rejects(f.call('edit_shared_file', { path: 'read.txt', oldText: 'viewer', newText: 'forbidden' }), /只有读取权限/)
  assert.deepEqual(f.requests, []); assert.equal(readFileSync(path.join(f.first, 'read.txt'), 'utf8'), 'viewer readable')
})

test('denial, role revocation, rebinding, logout and session deletion during approval prevent every file write', async t => {
  for (const reason of ['denial', 'role', 'binding', 'logout', 'deleted']) await t.test(reason, async child => {
    const f = fileFixture(child)
    f.hook(async () => {
      if (reason === 'denial') f.deny()
      if (reason === 'role') f.spaces[0]!.role = 'viewer'
      if (reason === 'binding') f.states.set(f.first, { spaceId: randomUUID() })
      if (reason === 'logout') f.detach()
      if (reason === 'deleted') f.sessions.setStatus(f.a.id, 'deleted')
    })
    await assert.rejects(f.call('write_shared_file', { path: 'forbidden.txt', content: 'never written' }))
    assert.equal(existsSync(path.join(f.first, 'forbidden.txt')), false)
    assert.equal(f.requests.length, 1)
  })
})

test('switching shared directories away and back during approval rejects the stale operation', async t => {
  const f = fileFixture(t)
  f.hook(async () => {
    f.service.selectDirectory(f.a.id, f.second, f.service.directory(f.a.id).revision)
    f.service.selectDirectory(f.a.id, f.first, f.service.directory(f.a.id).revision)
  })
  await assert.rejects(f.call('write_shared_file', { path: 'stale.txt', content: 'stale' }), /共享目录.*变化/)
  assert.equal(existsSync(path.join(f.first, 'stale.txt')), false)
  assert.equal(existsSync(path.join(f.second, 'stale.txt')), false)
})

test('version checks protect concurrent external edits and read snapshots are isolated across actors', async t => {
  const f = fileFixture(t), filename = path.join(f.first, 'version.txt')
  writeFileSync(filename, 'original')
  await f.call('read_shared_file', { path: 'version.txt' })
  writeFileSync(filename, 'external change')
  await assert.rejects(f.call('write_shared_file', { path: 'version.txt', content: 'old rewrite' }), /changed|改变/)
  await assert.rejects(f.call('edit_shared_file', { path: 'version.txt', oldText: 'change', newText: 'rewrite' }), /改变/)
  assert.equal(readFileSync(filename, 'utf8'), 'external change')
  await f.call('write_shared_file', { path: 'version.txt', content: 'fresh actor rewrite' }, f.tools('different actor'))
  f.hook(async () => { writeFileSync(filename, 'changed during approval') })
  await assert.rejects(f.call('write_shared_file', { path: 'version.txt', content: 'approval stale' }, f.tools('fresh actor')), /changed|改变/)
  assert.equal(readFileSync(filename, 'utf8'), 'changed during approval')
})

test('shared paths cannot escape via absolute paths, traversal or directory links, and cancellation writes nothing', async t => {
  const f = fileFixture(t)
  for (const requested of [path.join(f.project, 'private.txt'), '../private.txt', 'nested/../private.txt', 'bad\0name']) {
    await assert.rejects(f.call('read_shared_file', { path: requested }), /相对路径/)
    await assert.rejects(f.call('write_shared_file', { path: requested, content: 'escape' }), /相对路径/)
  }
  symlinkSync(f.project, path.join(f.first, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(path.join(f.project, 'private.txt'), 'secret project')
  await assert.rejects(f.call('read_shared_file', { path: 'outside/private.txt' }))
  await assert.rejects(f.call('write_shared_file', { path: 'outside/new.txt', content: 'escape' }))
  assert.equal(existsSync(path.join(f.project, 'new.txt')), false)
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(f.call('write_shared_file', { path: 'cancelled.txt', content: 'cancelled' }, f.tools(), controller.signal), /cancelled/)
  assert.equal(existsSync(path.join(f.first, 'cancelled.txt')), false)
})

test('independent selection persists, validates revisions and account ownership, and does not replace session workspace settings', t => {
  const f = fileFixture(t), filename = path.join(f.directory, 'shared-workspace-lan', 'selected-directory.json')
  const persisted = new SharedDirectorySelection(filename, f.account.key), first = persisted.read()
  assert.equal(first.path, f.first)
  const changed = persisted.select(f.second, first.revision)
  assert.notEqual(first.revision, changed.revision)
  assert.throws(() => persisted.select(f.first, first.revision), /已改变/)
  assert.throws(() => new SharedDirectorySelection(filename, 'another-account').read(), /其他账号/)
  assert.equal(f.workspace.forSession(f.a.id).root(), f.project)
  mkdirSync(path.join(f.directory, 'unused'))
  assert.equal(new SharedDirectorySelection(path.join(f.directory, 'unused', 'selection.json'), f.account.key).read().status, 'unselected')
})

test('the separate bundled shared skill declares its own tools and read-only subagents never receive shared writes', () => {
  const guide = builtinSkillSnapshots().find(item => item.name === 'eden-shared-library')!
  assert.ok(guide)
  const content = Buffer.from(guide.files['SKILL.md']!, 'base64').toString('utf8')
  for (const tool of ['query_shared_workspace', 'read_shared_file', 'write_shared_file', 'edit_shared_file']) assert.ok(content.includes(tool))
  assert.match(content, /与会话工作区分开/)
  assert.ok(rolePolicy('researcher').allowedTools?.includes('read_shared_file'))
  assert.ok(!rolePolicy('researcher').allowedTools?.includes('write_shared_file'))
  assert.ok(rolePolicy('researcher').deniedTools?.includes('write_shared_file'))
})

test('shared deletion, rename and recovery stay in the bound library and keep backups outside sync collection', async t => {
  const f = fileFixture(t)
  writeFileSync(path.join(f.first, 'remove.txt'), 'shared bytes')
  writeFileSync(path.join(f.project, 'remove.txt'), 'project bytes')
  const renamed = await f.call('rename_shared_file', { path: 'remove.txt', destination: 'renamed.txt' })
  assert.equal(renamed.synchronized, false)
  assert.equal(existsSync(path.join(f.first, 'remove.txt')), false)
  writeFileSync(path.join(f.first, 'renamed.txt'), 'later modified')
  await f.call('restore_shared_file', { recoveryId: renamed.result.recoveryId }, f.tools('main', 'next-turn'))
  assert.equal(readFileSync(path.join(f.first, 'remove.txt'), 'utf8'), 'shared bytes')
  assert.equal(readFileSync(path.join(f.project, 'remove.txt'), 'utf8'), 'project bytes')
  f.states.set(f.first, { spaceId: randomUUID() })
  await assert.rejects(f.call('restore_shared_file', { recoveryId: renamed.result.recoveryId }), /不属于/)
  assert.ok(rolePolicy('researcher').deniedTools.includes('delete_shared_file'))
  assert.ok(rolePolicy('researcher').deniedTools.includes('rename_shared_file'))
})

test('shared destructive operations refuse denial, revoked roles, changed contents and occupied destinations', async t => {
  for (const reason of ['denial', 'viewer', 'changed', 'destination', 'binding', 'selection']) await t.test(reason, async child => {
    const f = fileFixture(child), filename = path.join(f.first, 'keep.txt')
    writeFileSync(filename, 'original')
    if (reason === 'viewer') f.spaces[0]!.role = 'viewer'
    if (reason === 'destination') writeFileSync(path.join(f.first, 'other.txt'), 'occupied')
    f.hook(async () => {
      if (reason === 'denial') f.deny()
      if (reason === 'changed') writeFileSync(filename, 'concurrent')
      if (reason === 'binding') f.states.set(f.first, { spaceId: randomUUID() })
      if (reason === 'selection') f.service.selectDirectory(f.a.id, f.second, f.service.directory(f.a.id).revision)
    })
    await assert.rejects(f.call('rename_shared_file', { path: 'keep.txt', destination: 'other.txt' }))
    assert.equal(readFileSync(filename, 'utf8'), reason === 'changed' ? 'concurrent' : 'original')
    assert.equal(existsSync(path.join(f.first, 'other.txt')), reason === 'destination')
  })
})
