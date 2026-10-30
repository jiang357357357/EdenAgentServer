import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ssh2, { type Connection } from 'ssh2'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import { SharedWorkspaceService } from '../../../src/modules/shared-workspace/index.ts'
import type { SharedClientFactory } from '../../../src/modules/shared-workspace/contracts.ts'
import { fakeSharedLanRuntime } from '../../helpers/shared-lan-runtime.ts'

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-posture-ssh-')))
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  let authentications = 0
  const clients = new Set<Connection>()
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', context => { authentications++; context.reject() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = 'http://127.0.0.1:12345'
  const account = { coreBaseUrl: base, userId: '1', key: accountKey(base, '1') }
  const load = async () => Object.assign(() => assert.fail('SSH probing must not require a folder sync client'), {
    createLanRuntime: async () => fakeSharedLanRuntime(),
  }) as SharedClientFactory
  const service = new SharedWorkspaceService({ dataRoot: root, account, load,
    workspace: { root: () => root, info: () => ({ path: root, name: 'fixture', kind: 'external', status: 'ready', defaultPath: null, error: null }),
      mutate: async (_root, signal, work) => { signal.throwIfAborted(); return work() } },
    discover: () => ({ entry: '/fixture/client.ts', reason: null }),
  })
  const detach = service.attach(async () => ({ accountKey: account.key, coreBaseUrl: base, token: 'isolated-fixture' }))
  t.after(async () => {
    await service.close()
    for (const client of clients) client.end()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  const select = (mode: 'lan' | 'cloud') => service.selectPosture('fixture', mode, service.posture('fixture').revision)
  return { service, select, detach, authentications: () => authentications,
    target: { host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'fixture' } }
}

test('switching sharing mode without any folder client leaves fresh SSH probes usable', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  assert.equal(f.service.directory('fixture').status, 'unselected')
  const first = await f.service.sshProbe('', f.target)
  for (const mode of ['cloud', 'lan', 'cloud'] as const) {
    await f.select(mode)
    assert.equal(f.service.directory('fixture').status, 'unselected')
    assert.deepEqual(await f.service.sshProbe('', f.target), first)
  }
  assert.match(first.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.equal(f.authentications(), 0, 'fingerprint reads never attempt password or key authentication')
})

test('a mode change cancels an old SSH probe while a fresh probe works; logout stays cancelled', { timeout: 15000 }, async t => {
  const f = await fixture(t), sockets = new Set<Socket>()
  const hanging = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
  hanging.listen(0, '127.0.0.1'); await once(hanging, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => hanging.close(() => resolve())) })
  const interrupted = assert.rejects(f.service.sshProbe('', { ...f.target, port: (hanging.address() as AddressInfo).port }), /SSH 指纹读取已取消/)
  await once(hanging, 'connection')
  await f.select('cloud')
  await interrupted
  assert.match((await f.service.sshProbe('', f.target)).fingerprint, /^SHA256:/)
  f.detach()
  await assert.rejects(f.service.sshProbe('', f.target), /账号连接已关闭/)
  await assert.rejects(f.select('lan'), /账号连接已关闭/)
  await f.service.close()
  await assert.rejects(f.service.sshProbe('', f.target), /账号连接已关闭/)
  assert.equal(f.authentications(), 0)
})
