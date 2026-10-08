import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { sendWebsocketEvent } from '../../../src/transport/websocket/event-sender.ts'

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`)
    await delay(10)
  }
}

async function fixture(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const clients = []
  t.after(async () => {
    for (const client of clients) client.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const connect = async () => {
    const connected = once(server, 'connection')
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`)
    clients.push(client)
    await once(client, 'open')
    const [socket] = await connected
    let received = 0
    const closes = []
    client.on('message', () => { received++ })
    client.on('close', (code, reason) => closes.push({ code, reason: String(reason) }))
    return { client, socket, closes, get received() { return received } }
  }
  return { connect }
}

for (const resume of [true, false]) {
  test(`real TCP consumer ${resume ? 'resumes and receives the backlog' : 'stays paused and times out'} without blocking another connection`,
    { timeout: 30000 }, async t => {
      const { connect } = await fixture(t)
      const slow = await connect(), healthy = await connect()
      slow.client.pause()
      const payload = JSON.stringify({ method: 'fixture.large_event', content: 'x'.repeat(256 * 1024) })
      let writes = 0
      const sending = (async () => {
        for (let index = 0; index < 256; index++) {
          await sendWebsocketEvent(slow.socket, payload)
          writes++
        }
      })()
      // Observe failures immediately, even if an assertion below fails before awaiting this task.
      const outcome = sending.then(() => ({ ok: true }), error => ({ ok: false, message: error.message }))
      await until(() => slow.socket.bufferedAmount > 0, 'actual kernel/network backpressure')
      await delay(150)
      assert.ok(writes < 256, 'The paused peer must actually stop the write loop')
      assert.equal(slow.received, 0)
      await sendWebsocketEvent(healthy.socket, JSON.stringify({ method: 'fixture.peer_progress' }))
      await until(() => healthy.received === 1, 'independent healthy connection')
      const stalledWrites = writes
      if (resume) {
        slow.client.resume()
        assert.deepEqual(await outcome, { ok: true })
        await until(() => slow.received === 256, 'complete backlog after TCP reads resume')
        assert.deepEqual(slow.closes, [])
      } else {
        const result = await outcome
        assert.equal(result.ok, false)
        assert.match(result.message, /Event send timed out/)
        slow.client.resume()
        await until(() => slow.closes.length === 1, 'timeout close frame')
        assert.equal(slow.closes[0].code, 1013)
        assert.match(slow.closes[0].reason, /did not drain/)
      }
      await sendWebsocketEvent(healthy.socket, JSON.stringify({ method: 'fixture.peer_still_live' }))
      await until(() => healthy.received === 2, 'peer remains usable')
      assert.deepEqual(healthy.closes, [])
      t.diagnostic(JSON.stringify({ scenario: resume ? 'resume' : 'timeout', node: process.version,
        realTcp: true, framesOffered: 256, frameBytes: Buffer.byteLength(payload),
        writesBeforeResumeOrTimeout: stalledWrites, received: slow.received,
        closes: slow.closes, healthyPeerReceived: healthy.received }))
    })
}
