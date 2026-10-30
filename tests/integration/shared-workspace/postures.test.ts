import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSharedLanRuntime } from '@eden/shared-workspace'
import type { SharedClientFactory } from '../../../src/modules/shared-workspace/contracts.ts'
import { SharedLanOwner } from '../../../src/modules/shared-workspace/lan-owner.ts'

test('locking cloud posture closes LAN listener, stops publication, isolates authority, and survives restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-operating-postures-'))
  let loaded: { discovery?: boolean; host?: string; canPublish(): boolean } | undefined
  const factory = Object.assign(() => { throw new Error('No folder client in this owner test') }, {
    createLanRuntime: async (options: Parameters<typeof createSharedLanRuntime>[0]) => {
      loaded = options
      return createSharedLanRuntime({ ...options, host: options.host ?? '127.0.0.1' })
    },
  }) as SharedClientFactory
  const options = { dataRoot: path.join(root, 'client'), accountKey: 'account', active: () => true, canPublish: () => true, load: async () => factory }
  let owner = new SharedLanOwner(options)
  let cloud: Awaited<ReturnType<typeof createSharedLanRuntime>> | undefined
  try {
    const lan = await owner.ensure()
    const own = await lan.remote.request<{ space: { id: string } }>('POST', 'spaces', { name: 'LAN retained library' })
    const original = lan.network()
    assert.equal(loaded?.discovery, true)
    const locked = await owner.selectPosture('cloud', owner.posture.read().revision, async () => {})
    await assert.rejects(fetch(original.addresses[0]!, { signal: AbortSignal.timeout(2000) }))
    const client = await owner.ensure()
    assert.equal(loaded?.discovery, false); assert.equal(loaded?.host, '127.0.0.1'); assert.equal(loaded?.canPublish(), false)
    assert.notEqual(client.network().port, 0)
    assert.equal(client.network().deviceId, original.deviceId)
    assert.throws(() => client.invite(), /选择已连接的云主机/)
    await assert.rejects(client.remote.request('POST', 'spaces', { name: 'must not become local' }), /当前共享姿态/)
    await assert.rejects(client.remote.request('GET', `spaces/${own.space.id}/files`), /当前共享姿态/)
    assert.deepEqual((await client.hosts()).hosts, [])
    cloud = await createSharedLanRuntime({ dataRoot: path.join(root, 'cloud'), active: () => true, canPublish: () => true,
      dedicated: true, host: '127.0.0.1', discovery: false, administrators: [client.deploymentIdentity()] })
    await client.connectHost(cloud.invite().code)
    const sourceDirectory = path.join(root, 'cloud-files'); mkdirSync(sourceDirectory)
    const remote = await client.hostRequest<{ space: { id: string } }>(cloud.network().deviceId, 'POST', 'spaces', { name: 'Cloud authority', sourceDirectory, confirmSource: true })
    const cloudSpaces = await client.remote.request<{ spaces: { id: string }[] }>('GET', 'spaces')
    assert.deepEqual(cloudSpaces.spaces.map(space => space.id), [remote.space.id])
    await owner.selectPosture('cloud', locked.revision, async () => assert.fail('Clicking locked button must not reset runtime'))
    await owner.close(); await cloud.close()
    owner = new SharedLanOwner(options)
    assert.equal(owner.posture.read().mode, 'cloud')
    const offline = await owner.ensure()
    assert.equal((await offline.hosts()).hosts[0]?.dedicated, true)
    assert.equal((await offline.hosts()).hosts[0]?.reachable, false)
    await owner.selectPosture('lan', owner.posture.read().revision, async () => {})
    const restored = await owner.ensure()
    assert.equal(loaded?.discovery, true); assert.equal(loaded?.canPublish(), true)
    const restoredSpaces = await restored.remote.request<{ spaces: { id: string }[] }>('GET', 'spaces')
    assert.deepEqual(restoredSpaces.spaces.map(space => space.id), [own.space.id])
    await assert.rejects(restored.remote.request('GET', `spaces/${remote.space.id}/files`), /当前共享姿态/)
  } finally { await owner.close(); await cloud?.close(); rmSync(root, { recursive: true, force: true }) }
})
