import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DesktopBrokerClient } from '../../../src/modules/desktop/broker-client.ts'
import { serveDesktopBroker } from '../../../src/modules/desktop/broker-server.ts'
import { brokerPaths } from '../../../src/modules/desktop/broker-paths.ts'
import { DesktopError } from '../../../src/modules/desktop/contracts.ts'
import { jsonLines, send } from '../../../src/modules/desktop/framing.ts'
import { publishBrokerRegistration } from '../../../src/modules/desktop/broker-registration.ts'

const registration = (protocol = 'eden.desktop.1') => ({ token: 'a'.repeat(64), protocol, pid: process.pid })
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-broker-recovery-')), paths = brokerPaths(root)
  const clients: DesktopBrokerClient[] = [], brokers: Awaited<ReturnType<typeof serveDesktopBroker>>[] = []
  const servers: ReturnType<typeof createServer>[] = [], sockets = new Set<Socket>()
  let launches = 0
  const initial = JSON.stringify({ paused: true, stopped: false, control: { action: 'pause', source: 'manual', changedAt: 12345 } })
  await writeFile(paths.control, initial)
  t.after(async () => {
    for (const client of clients) client.close()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    await Promise.all(brokers.map(broker => broker.close()))
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  async function launch() {
    launches++
    try { brokers.push(await serveDesktopBroker(root, { observer: async () => { throw new Error('No GUI initialization permitted') } })) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error }
  }
  return { root, paths, initial, brokers, get launches() { return launches },
    client(start: () => void | Promise<void> = launch) {
      const client = new DesktopBrokerClient(root, { launch: start }); clients.push(client); return client
    },
    async endpoint(receive: (request: any, socket: Socket) => void = () => {}) {
      const server = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); jsonLines(socket, 128 * 1024, value => receive(value, socket)) })
      servers.push(server)
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.endpoint, () => { server.removeListener('error', reject); resolve() }) })
      return server
    },
  }
}

test('offline stale registration recovers even if its PID has been reused, preserving the exact pause state', async t => {
  const f = await fixture(t), client = f.client()
  await writeFile(f.paths.token, JSON.stringify(registration()))
  assert.equal(await client.connect(true), true)
  assert.equal(f.launches, 1)
  const metadata = JSON.parse(await readFile(f.paths.token, 'utf8'))
  assert.equal(metadata.protocol, 'eden.desktop.3')
  const status = await client.request({ type: 'status' }) as any
  assert.equal(status.paused, true); assert.equal(status.control.changedAt, 12345)
  assert.equal(status.observerAvailable, false)
  assert.equal(await readFile(f.paths.control, 'utf8'), f.initial)
})

test('status probing does not start a service or rewrite stale registration and control files', async t => {
  const f = await fixture(t), client = f.client()
  const original = JSON.stringify(registration('eden.desktop.2'))
  await writeFile(f.paths.token, original)
  assert.equal(await client.connect(false), false)
  assert.equal(f.launches, 0)
  assert.equal(await readFile(f.paths.token, 'utf8'), original)
  assert.equal(await readFile(f.paths.control, 'utf8'), f.initial)
})

test('a start request following an in-flight status probe still starts and authenticates the service', async t => {
  const f = await fixture(t), client = f.client()
  const status = client.connect(false), start = client.connect(true)
  assert.deepEqual(await Promise.all([status, start]), [false, true])
  assert.equal(f.launches, 1)
  assert.equal((await client.request({ type: 'status' }) as any).paused, true)
})

test('two worlds racing to recover stale registration share one live broker and retain pause', async t => {
  const f = await fixture(t)
  await writeFile(f.paths.token, JSON.stringify(registration()))
  const first = f.client(), second = f.client()
  assert.deepEqual(await Promise.all([first.connect(true), second.connect(true)]), [true, true])
  assert.equal(f.brokers.length, 1)
  assert.ok(f.launches >= 1 && f.launches <= 2)
  const statuses = await Promise.all([first.request({ type: 'status' }), second.request({ type: 'status' })]) as any[]
  assert.ok(statuses.every(status => status.paused && !status.busy))
  assert.equal(await readFile(f.paths.control, 'utf8'), f.initial)
})

for (const protocol of ['eden.desktop.1', 'eden.desktop.99']) {
  test(`a live incompatible endpoint (${protocol}) is retained without launching, downgrading or sending actions`, async t => {
    const f = await fixture(t), client = f.client(); let messages = 0
    const original = JSON.stringify(registration(protocol))
    await writeFile(f.paths.token, original)
    const server = await f.endpoint(() => { messages++ })
    await assert.rejects(client.connect(true), (error: DesktopError) => {
      assert.equal(error.code, 'BROKER_UPDATE_REQUIRED')
      assert.equal(error.diagnostics?.endpointReachable, true)
      assert.equal(error.diagnostics?.registeredProtocol, protocol)
      assert.match(error.message, /停止.*只停止桌面操作/)
      return true
    })
    assert.equal(server.listening, true); assert.equal(messages, 0); assert.equal(f.launches, 0)
    assert.equal(await readFile(f.paths.token, 'utf8'), original)
    assert.equal(await readFile(f.paths.control, 'utf8'), f.initial)
  })
}

test('publication after listen replaces the stale registration before authentication, without another launch', async t => {
  const f = await fixture(t), client = f.client()
  await writeFile(f.paths.token, JSON.stringify(registration()))
  await f.endpoint((request, socket) => {
    assert.equal(request.type, 'hello'); assert.equal(request.token, 'b'.repeat(64))
    send(socket, { id: request.id, result: { protocol: 'eden.desktop.3' } })
  })
  const publication = delay(80).then(() => publishBrokerRegistration(f.paths.token, 'b'.repeat(64)))
  const [connected] = await Promise.all([client.connect(true), publication])
  assert.equal(connected, true); assert.equal(f.launches, 0)
})

test('an active endpoint with broken metadata is diagnosed without overwriting or starting a competitor', async t => {
  const f = await fixture(t), client = f.client()
  await writeFile(f.paths.token, '{broken')
  const server = await f.endpoint()
  await assert.rejects(client.connect(true), (error: DesktopError) => error.code === 'BROKER_REGISTRATION_INVALID')
  assert.equal(f.launches, 0); assert.equal(server.listening, true)
  assert.equal(await readFile(f.paths.token, 'utf8'), '{broken')
})

test('malformed metadata left by an offline process can be replaced by the newly bound broker', async t => {
  const f = await fixture(t), client = f.client()
  await writeFile(f.paths.token, '{broken')
  assert.equal(await client.connect(true), true)
  assert.equal(JSON.parse(await readFile(f.paths.token, 'utf8')).protocol, 'eden.desktop.3')
  assert.equal(await readFile(f.paths.control, 'utf8'), f.initial)
})

test('callers wait for authenticated hello rather than treating an attached socket as ready', async t => {
  const f = await fixture(t), client = f.client()
  await writeFile(f.paths.token, JSON.stringify(registration('eden.desktop.3')))
  let entered!: () => void, acknowledge!: () => void
  const hello = new Promise<void>(resolve => { entered = resolve })
  await f.endpoint((request, socket) => {
    acknowledge = () => send(socket, { id: request.id, result: { protocol: 'eden.desktop.3' } }); entered()
  })
  const first = client.connect(false); await hello
  let ready = false
  const second = client.connect(true).then(result => { ready = true; return result })
  await delay(10); assert.equal(ready, false)
  acknowledge(); assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(f.launches, 0)
})

test('a successful connection must receive the exact protocol acknowledgement', async t => {
  const f = await fixture(t), client = f.client()
  await writeFile(f.paths.token, JSON.stringify(registration('eden.desktop.3')))
  await f.endpoint((request, socket) => send(socket, { id: request.id, result: { protocol: 'eden.desktop.1' } }))
  await assert.rejects(client.connect(true), (error: DesktopError) => error.code === 'BROKER_HANDSHAKE_INVALID')
  assert.equal(f.launches, 0)
})

test('loss after an execute is uncertain, and reconnect only authenticates without replaying the action', async t => {
  const f = await fixture(t), client = f.client(); let actions = 0
  await writeFile(f.paths.token, JSON.stringify(registration('eden.desktop.3')))
  await f.endpoint((request, socket) => {
    if (request.type === 'hello') send(socket, { id: request.id, result: { protocol: 'eden.desktop.3' } })
    else { actions++; socket.destroy() }
  })
  await client.connect(true)
  await assert.rejects(client.request({ type: 'execute', name: 'fixture-input' }), (error: DesktopError) => error.toolOutcome === 'unknown')
  await client.connect(true)
  assert.equal(actions, 1); assert.equal(f.launches, 0)
})

test('failure to start propagates once without changing the persisted pause state', async t => {
  const f = await fixture(t); let attempts = 0
  const client = f.client(() => { attempts++; throw new DesktopError('fixture startup failed', 'BROKER_START_FAILED') })
  await assert.rejects(client.connect(true), (error: DesktopError) => error.code === 'BROKER_START_FAILED')
  assert.equal(attempts, 1); assert.equal(await readFile(f.paths.control, 'utf8'), f.initial)
})
