import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { PacketFrames, PacketReader, packet, cstring, subscriptions } from '../connectors/official/openttd/src/packets.ts'
import { serverAction } from '../connectors/official/openttd/src/actions.ts'
import { officialConnectorFixture } from './official-connector-fixture.ts'

test('OpenTTD packet framing handles fragmentation and validates subscriptions and command strings', () => {
  const frames = new PacketFrames(), result: number[] = [], encoded = packet(103, Buffer.from([1, 0]))
  frames.push(encoded.subarray(0, 1), type => result.push(type)); assert.equal(result.length, 0)
  frames.push(encoded.subarray(1), type => result.push(type)); assert.deepEqual(result, [103])
  assert.throws(() => new PacketFrames().push(Buffer.from([2, 0]), () => {}), /size/)
  assert.throws(() => new PacketReader(Buffer.alloc(1)).u16(), /Truncated/)
  assert.deepEqual(subscriptions(Buffer.from([1, 1, 9, 0, 64, 0, 0])).packets, [packet(2, Buffer.from([9, 0, 64, 0]))])
  assert.throws(() => serverAction('save_game', { save_name: 'x; quit' }))
  assert.throws(() => serverAction('send_chat', { text: 'a\0b' }))
})

test('real OpenTTD worker negotiates admin protocol and stops a gameplay plan at the first failed step', async t => {
  const actions: string[] = [], credentials: string[] = []
  const server = createServer(socket => {
    const frames = new PacketFrames()
    socket.on('error', () => {})
    socket.on('data', chunk => frames.push(chunk, (type, payload) => {
      if (type === 0) { credentials.push(new PacketReader(payload).string()); socket.write(packet(103, Buffer.from([1, 1, 9, 0, 64, 0, 0]))) }
      if (type === 6) {
        const request = JSON.parse(new PacketReader(payload).string()) as { action: string; request_id: string }
        actions.push(request.action)
        const reply = { type: 'command_result', request_id: request.request_id, bridge_version: 1, ok: request.action !== 'fail' }
        socket.write(packet(124, cstring(JSON.stringify(reply))))
      }
    }))
  })
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const port = (server.address() as { port: number }).port
  const f = await officialConnectorFixture(t, 'openttd', { host: '127.0.0.1', adminPort: port, gamePort: port === 3979 ? 3980 : 3979 }, 'admin-fixture')
  for (let attempt = 0; attempt < 30 && !actions.includes('ping'); attempt++) await delay(100)
  await delay(100)
  assert.deepEqual(credentials, ['admin-fixture'])
  const result = await f.launched.runtime.invoke('execute', 'gameplay_plan', { commands: [{ action: 'inspect_tile', x: 1, y: 2 }, { action: 'fail' }, { action: 'must_not_run' }] }, 'plan-1', f.signal) as { ok: boolean; failed_at: number }
  assert.equal(result.ok, false); assert.equal(result.failed_at, 1)
  assert.deepEqual(actions, ['ping', 'inspect_tile', 'fail'])
})
