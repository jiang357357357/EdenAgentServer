import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSharedLanRuntime, createSharedWorkspaceClient, type LanRuntime, type HostAdministrator } from '@eden/shared-workspace'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-cloud-host-'))
  const runtimes: LanRuntime[] = [], clients: ReturnType<typeof createSharedWorkspaceClient>[] = []
  t.after(async () => { for (const client of clients) await client.close(); for (const runtime of runtimes) await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const device = async (name: string, canPublish: boolean, administrators?: HostAdministrator[]) => {
    const runtime = await createSharedLanRuntime({ dataRoot: path.join(root, name), name, active: () => true,
      canPublish: () => canPublish, host: '127.0.0.1', discovery: false,
      ...(administrators ? { dedicated: true, administrators } : {}) })
    runtimes.push(runtime); return runtime
  }
  const client = async (runtime: LanRuntime, name: string) => {
    const directory = path.join(root, name); await mkdir(directory)
    const instance = createSharedWorkspaceClient({ dataRoot: path.join(root, `${name}-state`), remote: runtime.remote,
      workspace: () => ({ root: directory, key: name }), mutate: async (_root, work) => work() })
    clients.push(instance); return { instance, directory }
  }
  return { root, device, client, track: (runtime: LanRuntime) => runtimes.push(runtime) }
}
type SpaceResult = { space: { id: string; hostDeviceId: string; role: string } }

test('cloud deployment identity manages libraries; outbound-only receivers need no DLC and obey permissions', async t => {
  const f = await fixture(t), admin = await f.device('administrator', true), receiver = await f.device('receiver', false)
  const cloud = await f.device('cloud', true, [admin.deploymentIdentity()]), cloudId = cloud.network().deviceId
  await admin.connectHost(cloud.invite().code, cloud.network().addresses[0])
  const capabilities = await admin.hostRequest<{ canManage: boolean; dedicated: boolean }>(cloudId, 'GET', 'capabilities')
  assert.equal(capabilities.canManage, true); assert.equal(capabilities.dedicated, true)
  assert.equal((await admin.hosts()).hosts.find(host => host.deviceId === cloudId)?.canManage, true)
  const sourceDirectory = path.join(f.root, 'cloud-files'); await mkdir(sourceDirectory)
  const { space } = await admin.hostRequest<SpaceResult>(cloudId, 'POST', 'spaces', { name: 'Cloud documents', sourceDirectory, confirmSource: true })
  assert.equal(space.hostDeviceId, cloudId); assert.equal(space.role, 'owner')
  const invitation = await admin.hostRequest<{ code: string }>(cloudId, 'POST', 'pairing/invite')
  await receiver.connectHost(invitation.code, cloud.network().addresses[0])
  assert.deepEqual(cloud.network().peers.map(peer => peer.addresses), [[], []], 'cloud never calls NAT-bound children')
  assert.equal((await receiver.hosts()).hosts.find(host => host.deviceId === cloudId)?.canManage, false)
  await assert.rejects(receiver.hostRequest(cloudId, 'POST', 'spaces', { name: 'forbidden' }), /管理员/)
  await assert.rejects(receiver.hostRequest(cloudId, 'POST', 'pairing/invite'), /管理员/)
  await assert.rejects(receiver.hostRequest(cloudId, 'GET', 'devices'))
  assert.deepEqual(await receiver.remote.request('GET', 'spaces'), { spaces: [] })
  await admin.remote.request('PUT', `spaces/${space.id}/members`, { deviceId: receiver.network().deviceId, role: 'viewer' })
  const source = await f.client(admin, 'source'), target = await f.client(receiver, 'target')
  await source.instance.bind(space.id); await source.instance.sync()
  await writeFile(path.join(source.directory, 'notes.txt'), 'cloud persistent content')
  await source.instance.sync(); await receiver.remote.request('GET', 'spaces')
  await target.instance.bind(space.id); await target.instance.sync()
  assert.equal(await readFile(path.join(target.directory, 'notes.txt'), 'utf8'), 'cloud persistent content')
  await assert.rejects(receiver.remote.request('PUT', `spaces/${space.id}/blobs/${'a'.repeat(64)}`, { bytes: '' }), /只读/)
  await admin.remote.request('PUT', `spaces/${space.id}/members`, { deviceId: receiver.network().deviceId, role: 'editor' })
  await writeFile(path.join(target.directory, 'notes.txt'), 'receiver edit')
  await target.instance.sync(); await source.instance.sync()
  assert.equal(await readFile(path.join(source.directory, 'notes.txt'), 'utf8'), 'receiver edit')
  const file = source.instance.files()[0]!
  assert.equal((await source.instance.history(file.fileId)).versions.length, 2)
  await admin.hostRequest(cloudId, 'DELETE', `devices/${receiver.network().deviceId}`)
  assert.equal((await admin.hostRequest<{ devices: { deviceId: string; revoked: boolean }[] }>(cloudId, 'GET', 'devices'))
    .devices.find(device => device.deviceId === receiver.network().deviceId)?.revoked, true)
  await assert.rejects(receiver.remote.request('GET', `spaces/${space.id}/files`), /失效|权限/)
})

test('cloud identity, administrator, library and file versions survive a headless host restart', async t => {
  const f = await fixture(t), admin = await f.device('administrator', true)
  const cloud = await f.device('cloud', true, [admin.deploymentIdentity()]), cloudId = cloud.network().deviceId, port = cloud.network().port!
  await admin.connectHost(cloud.invite().code)
  const sourceDirectory = path.join(f.root, 'cloud-files'); await mkdir(sourceDirectory)
  const { space } = await admin.hostRequest<SpaceResult>(cloudId, 'POST', 'spaces', { name: 'Restart documents', sourceDirectory, confirmSource: true })
  const source = await f.client(admin, 'source')
  await source.instance.bind(space.id); await source.instance.sync()
  await writeFile(path.join(source.directory, 'persist.txt'), 'before restart'); await source.instance.sync()
  await cloud.close()
  const restarted = await createSharedLanRuntime({ dataRoot: path.join(f.root, 'cloud'), active: () => true, canPublish: () => true,
    dedicated: true, discovery: false, host: '127.0.0.1', port, administrators: [admin.deploymentIdentity()] })
  f.track(restarted)
  assert.equal(restarted.network().deviceId, cloudId)
  assert.equal((await admin.hostRequest<{ canManage: boolean }>(cloudId, 'GET', 'capabilities')).canManage, true)
  assert.equal((await admin.remote.request<{ spaces: { id: string }[] }>('GET', 'spaces')).spaces[0]?.id, space.id)
  await writeFile(path.join(source.directory, 'persist.txt'), 'after restart'); await source.instance.sync()
  assert.equal((await source.instance.history(source.instance.files()[0]!.fileId)).versions.length, 2)
})

test('a normal DLC child remains a host; connecting by address cannot grant it remote administration', async t => {
  const f = await fixture(t), host = await f.device('child-host', true), child = await f.device('receiver', false)
  await child.connectHost(host.invite().code, host.network().addresses[0])
  const id = host.network().deviceId
  assert.equal((await child.hosts()).hosts.find(value => value.deviceId === id)?.canManage, false)
  const { space } = await host.remote.request<SpaceResult>('POST', 'spaces', { name: 'Local host library' })
  await assert.rejects(child.hostRequest(id, 'POST', 'spaces', { name: 'unauthorized' }))
  await host.remote.request('PUT', `spaces/${space.id}/members`, { deviceId: child.network().deviceId, role: 'editor' })
  await child.remote.request('GET', 'spaces')
  await assert.rejects(child.remote.request('PUT', `spaces/${space.id}/members`, { deviceId: randomUUID(), role: 'editor' }), /权限|发布/)
  assert.equal((await child.remote.request<{ spaces: { role: string }[] }>('GET', 'spaces')).spaces[0]?.role, 'editor')
})
