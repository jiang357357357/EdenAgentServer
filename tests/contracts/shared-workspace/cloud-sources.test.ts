import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { rpcMethods } from '@eden/api'
import { sharedWorkspaceRoutes } from '../../../src/transport/rpc/shared-workspace.routes.ts'
import type { SharedWorkspaceService } from '../../../src/modules/shared-workspace/index.ts'

test('cloud directory RPC carries the selected host and remote path without selecting a local workspace', async () => {
  const sessionId = randomUUID(), hostDeviceId = randomUUID(), calls: unknown[][] = []
  const service = { forSession: (id: string) => {
    assert.equal(id, sessionId)
    return { cloudSourceRequest: async (...args: unknown[]) => {
      calls.push(args)
      return { path: '/srv/project', parent: '/srv', entries: [], truncated: false, selectable: true, reason: null }
    } }
  } } as unknown as SharedWorkspaceService
  await sharedWorkspaceRoutes(service)['sharedWorkspace.cloudDirectories']({ sessionId, hostDeviceId, expectedWorkspacePath: '', path: '/srv/project' })
  assert.deepEqual(calls, [['', hostDeviceId, 'POST', 'directories/list', { path: '/srv/project', after: undefined }]])
})

test('source creation and binding contracts require explicit consent', () => {
  const scope = { sessionId: randomUUID(), hostDeviceId: randomUUID(), expectedWorkspacePath: '' }
  const create = rpcMethods['sharedWorkspace.create'].params
  assert.equal(create.safeParse({ ...scope, name: '资料', sourceDirectory: '/srv/project' }).success, false)
  assert.equal(create.safeParse({ ...scope, name: '资料', sourceDirectory: '/srv/project', confirmSource: true }).success, true)
  const bind = rpcMethods['sharedWorkspace.source.bind'].params
  assert.equal(bind.safeParse({ ...scope, spaceId: randomUUID(), path: '/srv/project', confirmSource: false }).success, false)
})

test('folder creation is a separate cloud request with an explicit host, parent and single folder name', async () => {
  const sessionId = randomUUID(), hostDeviceId = randomUUID(), calls: unknown[][] = []
  const service = { forSession: () => ({ cloudSourceRequest: async (...args: unknown[]) => { calls.push(args); return { path: '/srv/new-folder' } } }) } as unknown as SharedWorkspaceService
  await sharedWorkspaceRoutes(service)['sharedWorkspace.cloudDirectory.create']({ sessionId, hostDeviceId, expectedWorkspacePath: '', parent: '/srv', name: 'new-folder' })
  assert.deepEqual(calls, [['', hostDeviceId, 'POST', 'directories/create', { parent: '/srv', name: 'new-folder' }]])
  assert.equal(rpcMethods['sharedWorkspace.cloudDirectory.create'].params.safeParse({ sessionId, expectedWorkspacePath: '', parent: '/srv', name: '' }).success, false)
})
