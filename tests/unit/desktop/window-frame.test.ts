import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmWindowFrame } from '../../../src/modules/desktop/window-frame.ts'
import type { DesktopIdentity, InputObserver, NativeWindow } from '../../../src/modules/desktop/contracts.ts'

const requested = { x: 320, y: 180, width: 640, height: 460 }
const window: NativeWindow = { app: 'fixture', title: 'fixture', pid: 1, windowId: '1', bounds: requested, minimized: false }
const identity: DesktopIdentity = { started: 'first', foreground: false, bounds: requested }

test('resize checks visible bounds rather than invisible resize borders', async () => {
  const observer = { identify: async () => ({ ...identity, bounds: { x: 312, y: 180, width: 656, height: 468 }, visibleBounds: requested }) }
  const result = await confirmWindowFrame(observer, window, identity, requested,
    { status: 'unknown', effect: 'unverifiable', message: 'unverifiable' }, new AbortController().signal)
  const value = result.value as any
  assert.equal(value.status, 'verified'); assert.equal(value.verification.state, 'confirmed')
  assert.equal(value.verification.scope, 'window_geometry'); assert.equal(value.execution.state, 'dispatched')
  assert.deepEqual(value.observedBounds, requested)
})

test('a driver success is downgraded when independent geometry readback differs', async () => {
  const observer = { identify: async () => identity }
  const result = await confirmWindowFrame(observer, window, identity, { ...requested, x: 999 },
    { status: 'verified', message: 'driver claims success' }, new AbortController().signal)
  const value = result.value as any
  assert.equal(value.status, 'delivered'); assert.equal(value.verification.state, 'mismatch')
})

test('a replacement process cannot provide verification for the original resize', async () => {
  const observer = { identify: async () => ({ ...identity, started: 'replacement' }) }
  const result = await confirmWindowFrame(observer, window, identity, requested,
    { status: 'delivered', message: 'dispatched' }, new AbortController().signal)
  const value = result.value as any
  assert.equal(value.status, 'delivered'); assert.equal(value.verification.state, 'unavailable')
})
