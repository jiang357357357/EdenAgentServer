import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService, workspaceTools } from '../../../src/modules/workspace/index.ts'
import { WorkspaceMutationQueue } from '../../../src/modules/workspace/mutation-queue.ts'
import { withAccount, accountKey } from '../../../src/modules/accounts/index.ts'
import { CommandService } from '../../../src/modules/commands/index.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'
import { workspaceRoutes } from '../../../src/transport/rpc/workspace.routes.ts'
import type { SessionService } from '../../../src/modules/sessions/index.ts'

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-session-workspace-')))
  const folder = (name: string) => { const value = path.join(directory, name); mkdirSync(value); return realpathSync(value) }
  const first = folder('中文 初始'), second = folder('另一项目')
  const database = new EdenDatabase(':memory:', 'local'), sessions = new SessionRepository(database, 'local')
  const workspace = new WorkspaceService(database, [], first)
  const a = sessions.create('A'), b = sessions.create('B')
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, first, second, database, sessions, workspace, a, b }
}

test('session selection persists independently, preserves existing files and never creates session directories', t => {
  const f = fixture(t), a = f.workspace.forSession(f.a.id), b = f.workspace.forSession(f.b.id)
  writeFileSync(path.join(f.first, '原文件.txt'), 'keep')
  const before = readdirSync(f.directory)
  const initialB = b.snapshot()
  a.switch(f.second)
  assert.equal(a.root(), f.second)
  assert.equal(b.root(), f.first)
  assert.equal(f.workspace.root(), f.first)
  assert.deepEqual(b.snapshot(), initialB)
  const restored = new WorkspaceService(f.database, [], f.first)
  assert.equal(restored.forSession(f.a.id).root(), f.second)
  assert.equal(restored.forSession(f.b.id).root(), f.first)
  const newer = f.sessions.create('New session')
  assert.equal(restored.forSession(newer.id).root(), f.first)
  assert.deepEqual(readdirSync(f.directory), before)
  assert.equal(readFileSync(path.join(f.first, '原文件.txt'), 'utf8'), 'keep')
})

test('target session revision rejects stale approvals, including switch away and back, without invalidating other sessions', async t => {
  const f = fixture(t), a = f.workspace.forSession(f.a.id), b = f.workspace.forSession(f.b.id)
  const oldA = a.snapshot(), oldB = b.snapshot()
  a.switch(f.second); a.switch(f.first)
  assert.throws(() => a.assertSnapshot(oldA), /Session workspace changed/)
  assert.doesNotThrow(() => b.assertSnapshot(oldB))
  let ran = false
  await assert.rejects(a.mutateFile(oldA, 'new.txt', new AbortController().signal, async () => { ran = true }), /changed/)
  assert.equal(ran, false)
  assert.deepEqual(new WorkspaceService(f.database, [], f.first).forSession(f.b.id).snapshot(), oldB)
})

test('workspace facade rejects foreign and deleted sessions before reading or changing selection', t => {
  const f = fixture(t), origin = 'http://fixture.invalid'
  const account = (userId: string) => ({ userId, coreBaseUrl: origin, key: accountKey(origin, userId) })
  const owner = account('owner'), stranger = account('stranger')
  const session = withAccount(owner, () => f.sessions.create('Private'))
  const scoped = withAccount(owner, () => f.workspace.forSession(session.id))
  assert.throws(() => withAccount(stranger, () => scoped.info()), /不属于当前账号/)
  assert.throws(() => withAccount(stranger, () => scoped.switch(f.second)), /不属于当前账号/)
  assert.equal(withAccount(owner, () => scoped.root()), f.first)
  f.sessions.setStatus(session.id, 'deleted')
  assert.throws(() => scoped.info(), /Session not found/)
})

test('workspace RPC switches idle A while B is active and requires explicit session scope', async t => {
  const f = fixture(t)
  const service = { repository: f.sessions, isRunning: (id: string) => id === f.b.id } as unknown as SessionService
  const routes = workspaceRoutes(f.workspace, service)
  await routes['workspace.switch']!({ sessionId: f.a.id, path: f.second })
  assert.equal(f.workspace.forSession(f.a.id).root(), f.second)
  assert.equal(f.workspace.forSession(f.b.id).root(), f.first)
  await assert.rejects(routes['workspace.switch']!({ sessionId: f.b.id, path: f.second }) as Promise<unknown>, /this session/)
  await assert.rejects(routes['workspace.info']!({}) as Promise<unknown>)
})

test('path mutation queue allows disjoint files and roots while preserving overlap order after cancellation', async () => {
  const queue = new WorkspaceMutationQueue(), signal = new AbortController().signal
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), seen: string[] = []
  const root = path.resolve('queue-project'), other = path.resolve('other-project')
  const first = queue.run(signal, async () => { seen.push('first'); await hold }, { path: path.join(root, 'a'), kind: 'file' })
  await queue.run(signal, async () => { seen.push('second') }, { path: path.join(root, 'b'), kind: 'file' })
  await queue.run(signal, async () => { seen.push('other') }, { path: other, kind: 'directory' })
  const cancellation = new AbortController()
  const cancelled = queue.run(cancellation.signal, async () => { seen.push('cancelled') }, { path: root, kind: 'directory' })
  const rejection = assert.rejects(cancelled, /cancelled/)
  cancellation.abort(); await rejection
  const last = queue.run(signal, async () => { seen.push('last') }, { path: path.join(root, 'a'), kind: 'file' })
  assert.deepEqual(seen, ['first', 'second', 'other'])
  release(); await Promise.all([first, last])
  assert.deepEqual(seen, ['first', 'second', 'other', 'last'])
})

test('explicitly shared files reject a second session stale write instead of overwriting the first', async t => {
  const f = fixture(t), filename = path.join(f.first, 'shared.txt')
  writeFileSync(filename, 'original')
  const permissions = { request: async () => {} } as unknown as PermissionService
  const commands = new CommandService(f.database, [], undefined, { deviceSettingsPath: path.join(f.directory, 'terminal.json') })
  const tools = (sessionId: string) => workspaceTools(f.workspace.forSession(sessionId), permissions, sessionId, randomUUID(), commands)
  const a = tools(f.a.id), b = tools(f.b.id), context = { callId: 'fixture', signal: new AbortController().signal }
  await a.find(tool => tool.name === 'read_file')!.execute({ path: 'shared.txt' }, context)
  await b.find(tool => tool.name === 'read_file')!.execute({ path: 'shared.txt' }, context)
  await a.find(tool => tool.name === 'write_file')!.execute({ path: 'shared.txt', content: 'A edited' }, context)
  await assert.rejects(b.find(tool => tool.name === 'write_file')!.execute({ path: 'shared.txt', content: 'B edited' }, context), /File changed since it was read/)
  assert.equal(readFileSync(filename, 'utf8'), 'A edited')
})
