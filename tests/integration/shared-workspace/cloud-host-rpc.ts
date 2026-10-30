import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createSharedLanRuntime, type LanRuntime } from '@eden/shared-workspace'

export async function exerciseCloudHostRpc(request: (method: string, input: unknown) => Promise<Record<string, unknown>>,
  dataRoot: string, directory: string, scope: { sessionId: string; expectedWorkspacePath: string }, peer: LanRuntime) {
  const { deviceId, publicKey } = JSON.parse(await readFile(path.join(dataRoot, 'shared-workspace-lan/lan/device.json'), 'utf8')) as { deviceId: string; publicKey: string }
  const cloud = await createSharedLanRuntime({ dataRoot: path.join(directory, 'cloud-rpc-host'), name: 'RPC cloud host',
    active: () => true, canPublish: () => true, dedicated: true, discovery: false, host: '127.0.0.1', administrators: [{ deviceId, publicKey }] })
  const hostDeviceId = cloud.network().deviceId, root = path.join(directory, 'cloud-rpc-files')
  await mkdir(root)
  const cloudScope = { sessionId: scope.sessionId, expectedWorkspacePath: root }
  const originalPosture = await request('sharedWorkspace.posture.read', { sessionId: scope.sessionId })
  try {
    await request('sharedWorkspace.posture.select', { sessionId: scope.sessionId, mode: 'cloud', expectedRevision: originalPosture.revision })
    const initialDirectory = await request('sharedWorkspace.directory.read', { sessionId: scope.sessionId })
    const accountScope = { sessionId: scope.sessionId, expectedWorkspacePath: initialDirectory.path }
    const connected = await request('sharedWorkspace.connectHost', { ...accountScope, code: cloud.invite().code, address: cloud.network().addresses[0] })
    assert.equal(connected.deviceId, hostDeviceId)
    const hosts = await request('sharedWorkspace.hosts', accountScope)
    assert.equal((hosts.hosts as { deviceId: string; canManage: boolean }[]).find(value => value.deviceId === hostDeviceId)?.canManage, true)
    const sourceDirectory = path.join(directory, 'cloud-source-files'); await mkdir(sourceDirectory)
    const listing = await request('sharedWorkspace.cloudDirectories', { ...accountScope, hostDeviceId, path: sourceDirectory })
    assert.equal(listing.path, sourceDirectory)
    const created = await request('sharedWorkspace.create', { ...accountScope, hostDeviceId, name: 'RPC cloud documents', sourceDirectory, confirmSource: true })
    assert.equal((await request('sharedWorkspace.directory.read', { sessionId: scope.sessionId })).path, initialDirectory.path,
      'creating a cloud source must not select or bind a local directory')
    const selected = await request('sharedWorkspace.directory.read', { sessionId: scope.sessionId })
    await request('sharedWorkspace.directory.select', { sessionId: scope.sessionId, path: root, expectedRevision: selected.revision })
    const space = created.space as { id: string; hostDeviceId: string; role: string }
    assert.equal(space.hostDeviceId, hostDeviceId); assert.equal(space.role, 'owner')
    await request('sharedWorkspace.bind', { ...cloudScope, spaceId: space.id, confirmShare: true })
    const invited = await request('sharedWorkspace.invitePairing', { ...cloudScope, hostDeviceId })
    await peer.connectHost(String(invited.code), cloud.network().addresses[0])
    const devices = (await request('sharedWorkspace.devices', { ...cloudScope, hostDeviceId })).devices as { deviceId: string; local: boolean }[]
    assert.equal(devices.find(device => device.local)?.deviceId, hostDeviceId)
    assert.ok(devices.some(device => device.deviceId === peer.network().deviceId))
    await request('sharedWorkspace.members', { ...cloudScope, action: 'set', deviceId: peer.network().deviceId, role: 'viewer' })
    await writeFile(path.join(root, 'rpc-cloud.txt'), 'authenticated RPC -> standalone host')
    assert.equal((await request('sharedWorkspace.sync', cloudScope)).state, 'idle')
    await peer.remote.request('GET', 'spaces')
    assert.equal((await peer.remote.request<{ files: unknown[] }>('GET', `spaces/${space.id}/files`)).files.length, 1)
    await assert.rejects(peer.remote.request('PUT', `spaces/${space.id}/blobs/${'a'.repeat(64)}`, { bytes: '' }), /只读/)
    await request('sharedWorkspace.revokeDevice', { ...cloudScope, hostDeviceId, deviceId: peer.network().deviceId })
    await assert.rejects(peer.remote.request('GET', `spaces/${space.id}/files`))
    assert.equal((await request('sharedWorkspace.deploymentStatus', cloudScope)), null)
  } finally {
    const selected = await request('sharedWorkspace.posture.read', { sessionId: scope.sessionId })
    await request('sharedWorkspace.posture.select', { sessionId: scope.sessionId, mode: originalPosture.mode, expectedRevision: selected.revision })
    await cloud.close()
  }
}
