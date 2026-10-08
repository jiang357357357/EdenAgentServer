import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { workspaceStartupFixture, workspaceResult, workspaceRpc, type WorkspaceInfo } from './workspace-startup-fixture.ts'

const dataRoot = (portable: string) => path.join(portable, 'Data', 'Agent', 'realms', 'mon')

async function movePortable(temporaryRoot: string, original: string, moved: string) {
  assert.equal(path.dirname(path.resolve(original)), path.resolve(temporaryRoot))
  assert.equal(path.dirname(path.resolve(moved)), path.resolve(temporaryRoot))
  assert.equal(existsSync(moved), false)
  await rename(original, moved)
  assert.equal(existsSync(original), false, 'The complete previous installation must be absent')
}

test('moving the whole portable directory through Chinese and spaced paths relocates both managed account workspaces', async t => {
  const fixture = await workspaceStartupFixture(t)
  const original = path.join(fixture.temporaryRoot, '打包 原位置')
  const moved = path.join(fixture.temporaryRoot, '客户 新目录')
  await fixture.start(dataRoot(original))
  const initial = []
  for (const [token, userId] of [['account-a', '101'], ['account-b', '202']] as const) {
    const socket = await fixture.connect(token)
    const session = await workspaceResult<{ id: string }>(socket, 'session.create', { title: `移动前 ${userId}` })
    const info = await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: session.id })
    assert.equal(info.kind, 'managed')
    assert.equal(info.status, 'ready')
    await writeFile(path.join(info.path, '资料 汉字.txt'), `账号 ${userId} 的已有文件`)
    initial.push({ token, userId, sessionId: session.id, path: info.path })
  }
  await writeFile(path.join(original, '便携包标记.txt'), 'whole installation')
  await fixture.stop()
  await movePortable(fixture.temporaryRoot, original, moved)
  assert.equal(await readFile(path.join(moved, '便携包标记.txt'), 'utf8'), 'whole installation')
  await fixture.start(dataRoot(moved))
  const restoredPaths = []
  for (const previous of initial) {
    const socket = await fixture.connect(previous.token)
    const info = await workspaceResult<WorkspaceInfo>(socket, 'workspace.info', { sessionId: previous.sessionId })
    assert.equal(info.kind, 'managed')
    assert.equal(info.status, 'ready')
    assert.equal(info.path, realpathSync(path.join(fixture.accountRoot(dataRoot(moved), previous.userId), 'workspace')))
    assert.notEqual(info.path, previous.path)
    assert.equal(existsSync(previous.path), false)
    const file = await workspaceResult<{ content: string }>(socket, 'workspace.read', { sessionId: previous.sessionId, path: '资料 汉字.txt' })
    assert.equal(file.content, `账号 ${previous.userId} 的已有文件`)
    assert.equal((await workspaceResult<{ id: string }>(socket, 'session.read', { sessionId: previous.sessionId })).id, previous.sessionId)
    restoredPaths.push(info.path)
  }
  assert.notEqual(restoredPaths[0], restoredPaths[1], 'Account workspaces remain distinct after relocation')
  await fixture.assertReady()
})

test('an explicitly selected project outside the portable directory keeps its exact location after a whole-directory move', async t => {
  const fixture = await workspaceStartupFixture(t)
  const original = path.join(fixture.temporaryRoot, '便携 原目录')
  const moved = path.join(fixture.temporaryRoot, '便携 移动后')
  const project = path.join(fixture.temporaryRoot, '用户 手选项目')
  await mkdir(project)
  await writeFile(path.join(project, '项目文件.txt'), 'external project remains in place')
  await fixture.start(dataRoot(original))
  const initial = await fixture.connect('account-a')
  const session = await workspaceResult<{ id: string }>(initial, 'session.create', { title: 'Explicit external project' })
  await workspaceResult(initial, 'workspace.switch', { sessionId: session.id, path: project })
  assert.equal((await workspaceResult<WorkspaceInfo>(initial, 'workspace.info', { sessionId: session.id })).kind, 'external')
  await fixture.stop()
  await movePortable(fixture.temporaryRoot, original, moved)
  await fixture.start(dataRoot(moved))
  const restarted = await fixture.connect('account-a')
  const info = await workspaceResult<WorkspaceInfo>(restarted, 'workspace.info', { sessionId: session.id })
  assert.equal(info.kind, 'external')
  assert.equal(info.status, 'ready')
  assert.equal(info.path, realpathSync(project))
  assert.equal((await workspaceResult<{ content: string }>(restarted, 'workspace.read', { sessionId: session.id, path: '项目文件.txt' })).content,
    'external project remains in place')
  await fixture.assertReady()
})

test('an explicitly selected project that moves with the package stays missing until reselected and never prevents account startup', async t => {
  const fixture = await workspaceStartupFixture(t)
  const original = path.join(fixture.temporaryRoot, '完整包 原位置')
  const moved = path.join(fixture.temporaryRoot, '完整包 新位置')
  const project = path.join(original, '手选 项目')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, '不能丢失.txt'), 'explicit selection must not be guessed')
  await fixture.start(dataRoot(original))
  const initial = await fixture.connect('account-a')
  const session = await workspaceResult<{ id: string }>(initial, 'session.create', { title: 'Do not silently relocate external project' })
  await workspaceResult(initial, 'workspace.switch', { sessionId: session.id, path: project })
  const originalInfo = await workspaceResult<WorkspaceInfo>(initial, 'workspace.info', { sessionId: session.id })
  await fixture.connect('account-b')
  await fixture.stop()
  await movePortable(fixture.temporaryRoot, original, moved)
  await fixture.start(dataRoot(moved))
  const a = await fixture.connect('account-a'), b = await fixture.connect('account-b')
  const peer = await workspaceResult<{ id: string }>(b, 'session.create', { title: 'peer account' })
  const missing = await workspaceResult<WorkspaceInfo>(a, 'workspace.info', { sessionId: session.id })
  assert.equal(missing.kind, 'external')
  assert.equal(missing.status, 'missing')
  assert.equal(missing.path, originalInfo.path)
  assert.ok((await workspaceRpc(a, 'workspace.read', { sessionId: session.id, path: '不能丢失.txt' })).error)
  assert.equal((await workspaceResult<{ id: string }>(a, 'session.read', { sessionId: session.id })).id, session.id)
  assert.equal((await workspaceResult<WorkspaceInfo>(b, 'workspace.info', { sessionId: peer.id })).status, 'ready')
  await fixture.assertReady()
  const movedProject = path.join(moved, '手选 项目')
  assert.equal(await readFile(path.join(movedProject, '不能丢失.txt'), 'utf8'), 'explicit selection must not be guessed')
  await workspaceResult(a, 'workspace.switch', { sessionId: session.id, path: movedProject })
  assert.equal((await workspaceResult<WorkspaceInfo>(a, 'workspace.info', { sessionId: session.id })).path, realpathSync(movedProject))
  assert.equal((await workspaceResult<{ content: string }>(a, 'workspace.read', { sessionId: session.id, path: '不能丢失.txt' })).content,
    'explicit selection must not be guessed')
  assert.equal(existsSync(original), false, 'Recovery must not recreate the previous installation')
})
