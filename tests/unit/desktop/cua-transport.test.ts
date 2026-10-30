import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CuaTransport } from '../../../src/modules/desktop/cua-transport.ts'
import { DesktopError } from '../../../src/modules/desktop/contracts.ts'

function fixture(mode = '') {
  let launches = 0
  const transport = new CuaTransport(() => {
    launches++
    return spawn(process.execPath, [fileURLToPath(new URL('./cua-process-fixture.mjs', import.meta.url)), mode], { windowsHide: true, stdio: 'pipe' })
  })
  return { transport, get launches() { return launches } }
}

test('a worker DPI bootstrap refusal reaches the caller before any driver action', async t => {
  const f = fixture('dpi-failure'); t.after(() => f.transport.close())
  await assert.rejects(f.transport.prepare(new AbortController().signal), (error: DesktopError) => {
    assert.equal(error.code, 'CUA_DPI_CONTEXT_UNAVAILABLE'); assert.equal(error.toolOutcome, 'failed')
    assert.match(error.message, /before native startup/); return true
  })
  assert.equal(f.launches, 1)
})

test('native process loss faults input once, and a new generation is prepared without replay', async t => {
  const f = fixture(); t.after(() => f.transport.close())
  const signal = new AbortController().signal
  assert.equal(await f.transport.prepare(signal), 1)
  await assert.rejects(f.transport.request('crash', {}, signal, true), (error: DesktopError) => error.toolOutcome === 'unknown')
  assert.equal(f.launches, 1)
  assert.equal(await f.transport.prepare(signal), 2)
  assert.deepEqual(await f.transport.request('windows', {}, signal), [])
  assert.equal(f.launches, 2)
})

test('cancellation crosses the native transport and keeps an in-progress input uncertain', async t => {
  const f = fixture(); t.after(() => f.transport.close())
  const control = new AbortController()
  await f.transport.prepare(control.signal)
  const rejected = assert.rejects(f.transport.request('wait', { ack: 'fixture-ack' }, control.signal, true),
    (error: DesktopError) => error.code === 'CUA_CANCELLED' && error.toolOutcome === 'unknown')
  await delay(30); control.abort(); await rejected
  assert.equal(f.launches, 1)
})

test('native diagnostic fields survive the child boundary and cleanup never restarts a crashed worker', async t => {
  const f = fixture(); t.after(() => f.transport.close())
  const signal = new AbortController().signal
  await assert.rejects(f.transport.request('refuse', {}, signal), (error: DesktopError) => {
    assert.equal(error.code, 'background_unavailable'); assert.equal(error.toolOutcome, 'failed')
    assert.deepEqual(error.diagnostics?.windowBounds, { x: 1, y: 2, width: 3, height: 4 }); return true
  })
  await assert.rejects(f.transport.request('crash', {}, signal))
  await f.transport.request('release', {}, signal)
  assert.equal(f.launches, 1)
})
