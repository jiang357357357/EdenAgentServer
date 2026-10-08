import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { sendWebsocketEvent } from '../../../src/transport/websocket/event-sender.ts'

class SenderSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  readonly writes: string[] = []
  readonly closes: { code: number; reason: string }[] = []
  callback: ((error?: Error) => void) | undefined
  sendFailure: unknown
  send(serialized: string, callback: (error?: Error) => void): void {
    this.writes.push(serialized)
    this.callback = callback
    if (this.sendFailure !== undefined) throw this.sendFailure
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason })
    this.readyState = WebSocket.CLOSING
  }
  asWebSocket(): WebSocket { return this as unknown as WebSocket }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const socket = new SenderSocket()
  const send = () => sendWebsocketEvent(socket.asWebSocket(), '{"event":"fixture"}')
  const assertClean = () => {
    assert.equal(socket.listenerCount('close'), 0)
    assert.equal(socket.listenerCount('error'), 0)
  }
  return { socket, send, assertClean }
}

test('event writes remain pending until their callback succeeds and then clear the deadline and listeners', async t => {
  const { socket, send, assertClean } = fixture(t)
  let completed = false
  const pending = send().then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.deepEqual(socket.writes, ['{"event":"fixture"}'])
  assert.equal(socket.listenerCount('close'), 1)
  assert.equal(socket.listenerCount('error'), 1)
  socket.callback!()
  await pending
  assert.equal(completed, true)
  assertClean()
  t.mock.timers.tick(10000)
  assert.deepEqual(socket.closes, [])
})

test('write callback failure rejects once, removes listeners, and ignores later success or failure callbacks', async t => {
  const { socket, send, assertClean } = fixture(t)
  const failure = new Error('write callback failed')
  const pending = send()
  const rejected = assert.rejects(pending, error => error === failure)
  socket.callback!(failure)
  await rejected
  assertClean()
  socket.callback!()
  socket.callback!(new Error('late callback'))
  t.mock.timers.tick(10000)
  assert.deepEqual(socket.closes, [])
})

test('socket errors reject the active write and remove only the sender listeners', async t => {
  const { socket, send } = fixture(t)
  const existingClose = () => {}, existingError = () => {}
  socket.on('close', existingClose)
  socket.on('error', existingError)
  const failure = new Error('socket failure')
  const rejected = assert.rejects(send(), error => error === failure)
  socket.emit('error', failure)
  await rejected
  assert.deepEqual(socket.listeners('close'), [existingClose])
  assert.deepEqual(socket.listeners('error'), [existingError])
  socket.callback!()
  t.mock.timers.tick(10000)
  assert.deepEqual(socket.closes, [])
})

test('non-open sockets reject without starting a write, installing listeners, or scheduling a deadline', async t => {
  const { socket, send, assertClean } = fixture(t)
  for (const state of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
    socket.readyState = state
    await assert.rejects(send(), /Event connection is closed/)
    assertClean()
  }
  assert.deepEqual(socket.writes, [])
  t.mock.timers.tick(10000)
  assert.deepEqual(socket.closes, [])
})

test('closing while a write is pending rejects and cleans up before a late callback arrives', async t => {
  const { socket, send, assertClean } = fixture(t)
  const rejected = assert.rejects(send(), /Event connection closed during send/)
  socket.readyState = WebSocket.CLOSED
  socket.emit('close', 1000, Buffer.from('closed'))
  await rejected
  assertClean()
  socket.callback!()
  socket.callback!(new Error('late close callback'))
  t.mock.timers.tick(10000)
  assert.deepEqual(socket.closes, [])
})

test('synchronous send failures reject and clean up the pending deadline and event handlers', async t => {
  const { socket, send, assertClean } = fixture(t)
  for (const failure of [new Error('synchronous send failure'), 'non-Error send failure']) {
    socket.sendFailure = failure
    await assert.rejects(send(), failure instanceof Error ? /synchronous send failure/ : /Event send failed/)
    assertClean()
  }
  t.mock.timers.tick(10000)
  assert.deepEqual(socket.closes, [])
})

test('a write still pending at ten seconds closes with 1013, rejects, and ignores its late callback', async t => {
  const { socket, send, assertClean } = fixture(t)
  let settled = false
  const pending = send()
  const rejected = assert.rejects(pending, /Event send timed out/).then(() => { settled = true })
  t.mock.timers.tick(9999)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(socket.closes, [])
  t.mock.timers.tick(1)
  await rejected
  assert.deepEqual(socket.closes, [{ code: 1013, reason: 'Event consumer did not drain the connection' }])
  assertClean()
  socket.callback!()
  socket.callback!(new Error('write callback after timeout'))
  t.mock.timers.tick(20000)
  assert.equal(socket.closes.length, 1)
})
