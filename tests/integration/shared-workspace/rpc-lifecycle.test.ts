import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { cp, mkdir, mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { WebSocket } from 'ws'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import { attachWebsocket } from '../../../src/transport/websocket/upgrade.ts'
import { createSharedLanRuntime, createSharedWorkspaceClient } from '@eden/shared-workspace'
import { exerciseSharedModelQueries } from './model-query-runtime.ts'

for (const publisher of [true, false]) test(`authenticated ${publisher ? 'publisher with DLC' : 'receiver without installed DLC'} RPC pairs, syncs without Core file APIs and suspends on logout`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eden-shared-rpc-'))
  const dlc = path.join(directory, 'DLC', 'SharedWorkspace')
  await mkdir(path.join(directory, '.run', 'dlc'), { recursive: true })
  await writeFile(path.join(directory, '.monconfig'), '')
  await writeFile(path.join(directory, '.monworkspace'), '')
  if (publisher) {
    await cp(fileURLToPath(new URL('../../../../../DLC/SharedWorkspace', import.meta.url)), dlc, { recursive: true })
    await writeFile(path.join(directory, '.run', 'dlc', 'state.json'), '{"enabled":{"shared-workspace":true}}')
  } else await assert.rejects(access(dlc), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
  const priorRoot = process.env.MON_WORKSPACE_ROOT, priorDlc = process.env.MON_SHARED_WORKSPACE_DLC_ROOT
  process.env.MON_WORKSPACE_ROOT = directory; process.env.MON_SHARED_WORKSPACE_DLC_ROOT = dlc
  const observed: string[] = []
  const core = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Token rpc-fixture-only')
    const endpoint = request.url!.split('?')[0]!
    observed.push(endpoint)
    let value: unknown
    if (endpoint === '/api/users/me/profile/') value = { id: 31 }
    else { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const config = { ...loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_PORT: '0',
    MON_WORKSPACE_ROOT: directory,
    EDEN_AGENT_DATA_ROOT: path.join(directory, 'data'), EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(directory, 'terminal.json') }),
    coreBaseUrl: `http://127.0.0.1:${(core.address() as AddressInfo).port}` }
  const runtimes = new AccountRuntimes(config)
  const host = createServer()
  const server = attachWebsocket(host, config, token => runtimes.resolve(token))
  let client: WebSocket | undefined
  const peerRoot = path.join(directory, 'peer-folder'); await mkdir(peerRoot)
  const peer = await createSharedLanRuntime({ dataRoot: path.join(directory, 'independent-peer'), active: () => true, canPublish: () => !publisher, discovery: false, host: '127.0.0.1' })
  const peerClient = createSharedWorkspaceClient({ dataRoot: path.join(directory, 'peer-sync'), remote: peer.remote,
    workspace: () => ({ root: peerRoot, key: 'external:peer' }), mutate: async (_root, work) => work() })
  try {
    await runtimes.start(); host.listen(0, '127.0.0.1'); await once(host, 'listening')
    client = new WebSocket(`ws://127.0.0.1:${(host.address() as AddressInfo).port}/rpc`, ['eden-agent-rpc-v2', `eden-agent-token.${config.token}`])
    await once(client, 'open')
    await rpc(client, 'initialize', { protocolVersion: 2, runtimeOrigin: 'mon', clientName: 'fixture', clientVersion: '1',
      capabilities: [], coreToken: 'rpc-fixture-only' })
    const runtime = await runtimes.resolve('rpc-fixture-only')
    const session = await rpc(client, 'session.create', { title: 'Shared project' })
    const sessionId = String(session.id), projectRoot = runtime.services.workspace.forSession(sessionId).root()
    const sharedRoot = path.join(directory, 'independent-shared'); await mkdir(sharedRoot)
    const previous = await rpc(client, 'sharedWorkspace.directory.read', { sessionId })
    assert.equal(previous.status, 'unselected'); assert.equal(previous.path, '')
    assert.deepEqual((await rpc(client, 'sharedWorkspace.spaces', { sessionId, expectedWorkspacePath: '' })).spaces, [])
    assert.ok((await rpc(client, 'sharedWorkspace.network', { sessionId, expectedWorkspacePath: '' })).deviceId)
    await rpc(client, 'sharedWorkspace.directory.select', { sessionId, path: sharedRoot, expectedRevision: previous.revision })
    assert.equal(runtime.services.workspace.forSession(sessionId).root(), projectRoot)
    const scope = { sessionId, expectedWorkspacePath: sharedRoot }
    const status = await rpc(client, 'sharedWorkspace.status', { sessionId: scope.sessionId })
    assert.equal(status.available, true)
    assert.equal(status.canPublish, publisher)
    assert.equal((await peer.remote.request<{ canPublish: boolean }>('GET', 'capabilities')).canPublish, !publisher)
    if (!publisher) await assert.rejects(rpc(client, 'sharedWorkspace.create', { ...scope, name: 'Receiver cannot publish' }), /DLC/)
    else await assert.rejects(peer.remote.request('POST', 'spaces', { name: 'Receiver cannot publish' }), /DLC/)
    const created = publisher ? await rpc(client, 'sharedWorkspace.create', { ...scope, name: 'LAN RPC资料' })
      : await peer.remote.request<{ space: { id: string } }>('POST', 'spaces', { name: 'LAN RPC资料' })
    const spaceId = String((created.space as { id: string }).id)
    if (publisher) await rpc(client, 'sharedWorkspace.bind', { ...scope, spaceId, confirmShare: true })
    const network = await rpc(client, 'sharedWorkspace.network', scope)
    assert.match(String(network.deviceId), /^[0-9a-f-]{36}$/)
    if (publisher) {
      const invitation = await rpc(client, 'sharedWorkspace.invitePairing', scope)
      await peer.pair(String(invitation.code), `http://127.0.0.1:${Number(network.port)}`)
      await rpc(client, 'sharedWorkspace.members', { ...scope, action: 'set', deviceId: peer.network().deviceId, role: 'editor' })
    } else {
      await rpc(client, 'sharedWorkspace.pairDevice', { ...scope, code: peer.invite().code })
      await peer.remote.request('PUT', `spaces/${spaceId}/members`, { deviceId: String(network.deviceId), role: 'editor' })
    }
    if (!publisher) await rpc(client, 'sharedWorkspace.bind', { ...scope, spaceId, confirmShare: true })
    await writeFile(path.join(scope.expectedWorkspacePath, 'lan.txt'), 'source LAN file')
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const mutation = runtime.services.sharedWorkspace.forSession(scope.sessionId).mutateFiles(scope.expectedWorkspacePath, new AbortController().signal, () => hold)
    let synced = false
    const sync = rpc(client, 'sharedWorkspace.sync', scope).then(result => { synced = true; return result })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(synced, false, 'Local workspace mutation serializes actual LAN sync')
    release(); await mutation
    assert.equal((await sync).state, 'idle')
    await peer.remote.request('GET', 'spaces'); await peerClient.bind(spaceId); await peerClient.sync()
    assert.equal(await readFile(path.join(peerRoot, 'lan.txt'), 'utf8'), 'source LAN file')
    await writeFile(path.join(peerRoot, 'lan.txt'), 'peer edit'); await peerClient.sync(); await rpc(client, 'sharedWorkspace.sync', scope)
    assert.equal(await readFile(path.join(scope.expectedWorkspacePath, 'lan.txt'), 'utf8'), 'peer edit')
    await exerciseSharedModelQueries(runtime.services, scope.sessionId)
    assert.equal(runtime.services.workspace.forSession(sessionId).root(), projectRoot)
    await assert.rejects(access(path.join(projectRoot, 'skill-written.txt')), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
    assert.ok(observed.length > 0); assert.ok(observed.every(value => value === '/api/users/me/profile/'), 'Core is used only for local login identity')
    const serverClosed = once([...server.clients][0]!, 'close')
    client.close(); await Promise.all([once(client, 'close'), serverClosed])
    assert.equal((await runtime.services.sharedWorkspace.status()).available, false)
    const disconnected = await fetch(`http://127.0.0.1:${Number(network.port)}/eden-lan/v2/rpc`, { method: 'POST', body: '{}' }).catch(() => null)
    assert.ok(disconnected === null || disconnected.status !== 200)
    await disconnected?.body?.cancel()
  } finally {
    client?.terminate()
    for (const socket of server.clients) socket.terminate()
    server.close(); host.closeAllConnections(); core.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => host.close(() => resolve())), new Promise<void>(resolve => core.close(() => resolve()))])
    await runtimes.close()
    await peerClient.close(); await peer.close()
    if (priorRoot === undefined) delete process.env.MON_WORKSPACE_ROOT; else process.env.MON_WORKSPACE_ROOT = priorRoot
    if (priorDlc === undefined) delete process.env.MON_SHARED_WORKSPACE_DLC_ROOT; else process.env.MON_SHARED_WORKSPACE_DLC_ROOT = priorDlc
    await rm(directory, { recursive: true, force: true })
  }
})

function rpc(client: WebSocket, method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = Math.random().toString()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('message', receive); reject(new Error(`RPC timeout: ${method}`)) }, 10_000)
    const receive = (bytes: Buffer) => {
      const value = JSON.parse(String(bytes)) as { id?: string; result: Record<string, unknown>; error?: { message: string } }
      if (value.id !== id) return
      clearTimeout(timer); client.off('message', receive)
      if (value.error) reject(new Error(value.error.message)); else resolve(value.result)
    }
    client.on('message', receive)
    client.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}
