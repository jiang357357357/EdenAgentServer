import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { SharedWorkspaceService, sharedWorkspaceTool } from '../../../src/modules/shared-workspace/index.ts'
import type { SharedClient, SharedFile, SharedStatus } from '../../../src/modules/shared-workspace/contracts.ts'
import { fakeSharedLanRuntime } from '../../helpers/shared-lan-runtime.ts'

export function sharedModelFixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-shared-model-')))
  const first = path.join(directory, '共享资料'), second = path.join(directory, '另一个共享目录'), project = path.join(directory, '当前项目')
  mkdirSync(first); mkdirSync(second); mkdirSync(project)
  const account = { coreBaseUrl: 'http://fixture.invalid', userId: '1', key: accountKey('http://fixture.invalid', '1') }
  const database = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(database, 'mon')
  const workspace = new WorkspaceService(database, [], project)
  const a = withAccount(account, () => sessions.create('A')), b = withAccount(account, () => sessions.create('B'))
  workspace.forSession(b.id).switch(second)
  const spaces = [{ id: randomUUID(), name: '项目资料', role: 'viewer', hostName: '共享电脑', reachable: true, token: 'must-not-expose' }]
  const index = new Map<string, SharedFile[]>([[first, []], [second, []]])
  const states = new Map<string, Partial<SharedStatus>>()
  const requests: string[] = [], mutations: string[] = []
  mkdirSync(path.join(directory, 'shared-workspace-lan'))
  writeFileSync(path.join(directory, 'shared-workspace-lan', 'folders.json'), JSON.stringify({ version: 1, accountKey: account.key, folders: [] }))
  let barrier: (() => Promise<void>) | undefined
  const lan = fakeSharedLanRuntime()
  lan.remote.request = async <T>(method: string, endpoint: string): Promise<T> => {
    requests.push(`${method} ${endpoint}`)
    if (endpoint === 'spaces') { await barrier?.(); return { spaces } as T }
    return { protocolVersion: 2 } as T
  }
  const service = new SharedWorkspaceService({ dataRoot: directory, account, workspace, lan, assertSession: id => { sessions.readMetadata(id) },
    discover: () => ({ entry: null, reason: '发布 DLC 未安装' }),
    load: async () => options => {
      const root = options.workspace().root
      const client: SharedClient = {
        status: () => ({ root, bound: true, spaceId: spaces[0]!.id, paused: false, state: 'idle', pending: 0,
          conflicts: 0, lastSync: 1, error: null, ...states.get(root) }),
        files: () => index.get(root) ?? [], start: () => {}, suspend: async () => {}, close: async () => {}, conflicts: () => [],
        bind: async () => { mutations.push('bind') }, sync: async () => { mutations.push('sync') }, pause: () => { mutations.push('pause') },
        resolve: async () => { mutations.push('resolve') }, restore: async () => { mutations.push('restore') }, history: async () => ({}),
      }
      return client
    },
  })
  service.selectDirectory(a.id, first, '0')
  const detach = service.attach(async () => ({ accountKey: account.key, coreBaseUrl: account.coreBaseUrl, token: 'fixture-private-token' }))
  const tools = (sessionId = a.id) => [sharedWorkspaceTool(service, sessionId)]
  const call = (action: 'status' | 'spaces' | 'files', input: Record<string, unknown> = {}, sessionId = a.id, signal = new AbortController().signal) =>
    tools(sessionId)[0]!.execute({ action, ...input }, { callId: 'fixture', signal }) as Promise<Record<string, any>>
  t.after(async () => {
    await service.close(); database.close()
    assert.equal(path.dirname(directory), realpathSync(tmpdir()))
    assert.ok(path.basename(directory).startsWith('eden-shared-model-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, account, database, sessions, workspace, service, a, b, first, second, project, spaces, index, states, requests, mutations, detach,
    tools, call, hold: (pending: () => Promise<void>) => { barrier = pending } }
}

export function sharedFile(path: string, deleted = false): SharedFile {
  return { fileId: randomUUID(), path, revision: 1, deleted, size: 20, sha256: 'a'.repeat(64) }
}
