import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmWindowState } from '../../../src/modules/desktop/window-state.ts'
import type { DesktopIdentity, NativeWindow } from '../../../src/modules/desktop/contracts.ts'

const window: NativeWindow = { app: 'fixture', title: 'fixture', pid: 1, windowId: '1',
  bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false }
const identity: DesktopIdentity = { started: 'first', foreground: true, bounds: window.bounds, minimized: false, maximized: true }

test('restore detects a delivered no-op instead of trusting the transport acknowledgement', async () => {
  let reads = 0
  const result = await confirmWindowState({ identify: async () => { reads++; return identity } }, window, identity,
    'restore', { status: 'delivered', message: 'posted' }, new AbortController().signal)
  const value = result.value as any
  assert.equal(value.status, 'delivered'); assert.equal(value.execution.state, 'dispatched')
  assert.equal(value.verification.state, 'mismatch'); assert.equal(value.observedState.maximized, true)
  assert.equal(reads, 11)
})

test('restore waits for actual asynchronous state change and missing flags stay unavailable', async () => {
  let reads = 0
  const result = await confirmWindowState({ identify: async () => ({ ...identity, maximized: ++reads < 3 }) }, window, identity,
    'restore', { status: 'unknown', effect: 'unverifiable', message: 'posted' }, new AbortController().signal)
  const value = result.value as any
  assert.equal(value.status, 'verified'); assert.equal(value.verification.scope, 'native_window_state'); assert.equal(reads, 3)
  const missing = await confirmWindowState({ identify: async () => ({ started: 'first', bounds: window.bounds, foreground: true }) },
    window, identity, 'restore', { status: 'delivered', message: 'posted' }, new AbortController().signal)
  assert.equal((missing.value as any).verification.state, 'unavailable')
})
