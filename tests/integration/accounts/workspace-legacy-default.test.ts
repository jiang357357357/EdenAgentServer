import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { workspaceStartupFixture, workspaceResult, workspaceRpc, type WorkspaceInfo } from './workspace-startup-fixture.ts'

const external = (root: string) => ({ version: 1, kind: 'external', path: root })

test('real RPC startup repairs a deleted installation default and 21 inherited sessions, retaining three explicit projects', async t => {
  const fixture = await workspaceStartupFixture(t)
  const data = (name: string) => path.join(fixture.temporaryRoot, name, 'Data', 'Agent', 'realms', 'mon')
  const currentData = data('新便携包'), old = path.join(fixture.accountRoot(data('已删除的旧安装'), '101'), 'workspace')
  const current = path.join(fixture.accountRoot(currentData, '101'), 'workspace')
  const project = path.join(fixture.temporaryRoot, '普拉娜的工作报告')
  await mkdir(current, { recursive: true }); await mkdir(project)
  await writeFile(path.join(current, '已有资料.txt'), 'current package data')
  await writeFile(path.join(project, '工作报告.txt'), 'manual project data')
  const databasePath = await fixture.seedLegacy(currentData, '101', old)
  const inherited = { 'workspace.root': old, 'workspace.selection': external(old) }
  const manual = { 'workspace.root': realpathSync(project), 'workspace.selection': external(realpathSync(project)) }
  const ids = await fixture.seedSessions(databasePath, [...Array.from({ length: 21 }, () => inherited), manual, manual, manual])
  const database = new EdenDatabase(databasePath, 'mon')
  try { database.connection.prepare('INSERT INTO runtime_settings VALUES(?,?,?)').run('workspace.selection', JSON.stringify(external(old)), 1) }
  finally { database.close() }
  await fixture.start(currentData)
  let socket = await fixture.connect('account-a')
  for (const id of ids.slice(0, 21)) {
    const info = await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: id })
    assert.equal(info.kind, 'managed'); assert.equal(info.status, 'ready'); assert.equal(info.path, realpathSync(current))
  }
  for (const id of ids.slice(21)) {
    const info = await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: id })
    assert.equal(info.kind, 'external'); assert.equal(info.path, realpathSync(project))
  }
  assert.equal((await workspaceResult<{ content: string }>(socket, 'workspace.read', { sessionId: ids[0]!, path: '已有资料.txt' })).content,
    'current package data')
  const session = await workspaceResult<{ id: string }>(socket, 'session.create', { title: '新会话不再继承旧安装' })
  assert.equal((await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: session.id })).path, realpathSync(current))
  await fixture.assertReady(); await fixture.stop(); await fixture.start(currentData)
  socket = await fixture.connect('account-a')
  assert.equal((await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: session.id })).status, 'ready')
  assert.equal((await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: ids[21]! })).path, realpathSync(project))
  assert.equal(await readFile(path.join(project, '工作报告.txt'), 'utf8'), 'manual project data')
  assert.equal(existsSync(old), false)
  await fixture.assertReady()
})

test('new RPC sessions bypass an unproven dead global seed without silently changing existing sessions', async t => {
  const fixture = await workspaceStartupFixture(t), dataRoot = path.join(fixture.temporaryRoot, 'data')
  const missing = path.join(fixture.temporaryRoot, 'external-project-deleted')
  const databasePath = await fixture.seedLegacy(dataRoot, '101', missing)
  const [existing] = await fixture.seedSessions(databasePath, [{ 'workspace.root': missing, 'workspace.selection': external(missing) }])
  const current = path.join(fixture.accountRoot(dataRoot, '101'), 'workspace')
  await mkdir(current)
  await fixture.start(dataRoot)
  const socket = await fixture.connect('account-a')
  assert.equal((await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: existing! })).path, missing)
  assert.ok((await workspaceRpc(socket, 'workspace.read', { sessionId: existing!, path: 'nothing.txt' })).error)
  const session = await workspaceResult<{ id: string }>(socket, 'session.create', { title: '有效的新会话' })
  const info = await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: session.id })
  assert.equal(info.kind, 'managed'); assert.equal(info.status, 'ready'); assert.equal(info.path, realpathSync(current))
  assert.equal(existsSync(missing), false)
  await fixture.assertReady()
})
