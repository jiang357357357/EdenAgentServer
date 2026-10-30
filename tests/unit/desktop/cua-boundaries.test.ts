import assert from 'node:assert/strict'
import test from 'node:test'
import * as sdk from '@trycua/cua-driver'
import { nativeDriverAdapter, projectDriverAction } from '../../../src/modules/desktop/native-driver.ts'
import { projectNativeObservation } from '../../../src/modules/desktop/native-observation.ts'
import { stringifyCuaArgs, parseCuaJson } from '../../../src/modules/desktop/cua-json.ts'
import { CuaSessionNames } from '../../../src/modules/desktop/cua-session-names.ts'
import { CuaWorkerScopes } from '../../../src/modules/desktop/cua-worker-scopes.ts'
import { CuaDriverClient } from '../../../src/modules/desktop/cua-driver.ts'
import { cuaCatalog, assertNativeCuaCatalog } from '../../../src/modules/desktop/cua-catalog.ts'
import type { DesktopDriver, NativeWindow } from '../../../src/modules/desktop/contracts.ts'

test('the pinned native catalog fails closed on missing tools or changed parameters', () => {
  assertNativeCuaCatalog(JSON.stringify({ tools: cuaCatalog }))
  assert.throws(() => assertNativeCuaCatalog(JSON.stringify({ tools: cuaCatalog.slice(1) })), /不一致/)
  const altered = structuredClone(cuaCatalog); altered[0]!.inputSchema = { type: 'string' }
  assert.throws(() => assertNativeCuaCatalog(JSON.stringify({ tools: altered })), /不一致/)
})

test('unsafe HWND integers survive both JSON boundaries; snapshot handles remain strings', () => {
  const wire = stringifyCuaArgs({ window_id: '18446744073709551615', snapshot_id: 's12345678' })
  assert.match(wire, /"window_id":18446744073709551615/)
  assert.deepEqual(parseCuaJson(wire), { window_id: '18446744073709551615', snapshot_id: 's12345678' })
})

test('SDK adapter forwards type coordinates and hotkey tokens once, with no host text chunks', async () => {
  const calls: { name: string; input: string }[] = []
  let destroyed = false
  const native = {
    startSession: async () => ({ active: true, revived: false }), endSession: async () => ({}),
    callTool: async (name: string, input: string) => { calls.push({ name, input }); return { text: '', images: [], isError: false } },
    shutdown: async () => {}, uniffiDestroy: () => { destroyed = true },
  } as unknown as Parameters<typeof nativeDriverAdapter>[1]
  const driver = nativeDriverAdapter(sdk, native), signal = new AbortController().signal
  await driver.prepare!(signal)
  const text = '界'.repeat(160)
  await driver.act('type_text', { pid: 71, window_id: '18446744073709551615', x: 111, y: 222, text, snapshot: 's12345678', delivery_mode: 'foreground' }, signal)
  assert.equal(calls.length, 1)
  const typed = parseCuaJson(calls[0]!.input) as any
  assert.equal(typed.x, 111); assert.equal(typed.y, 222); assert.equal(typed.text, text)
  assert.equal(typed.window_id, '18446744073709551615'); assert.equal(typed.snapshot_id, undefined)
  assert.equal(typed.snapshot, undefined)
  await driver.act('hotkey', { element_token: 's12345678:7', snapshot: 's12345678', keys: ['ctrl', 'a'] }, signal)
  assert.equal(JSON.parse(calls.at(-1)!.input).element_token, 's12345678:7')
  await driver.act('drag', { scope: 'desktop', from_x: 1, from_y: 2, to_x: 3, to_y: 4, snapshot: 's12345678' }, signal)
  assert.equal(JSON.parse(calls.at(-1)!.input).snapshot_id, undefined)
  await driver.act('launch_app', { name: 'fixture' }, signal)
  assert.equal(JSON.parse(calls.at(-1)!.input).session, undefined)
  await driver.close(); assert.equal(destroyed, true)
})

test('driver refusals keep their original explanation and escalation across the compatibility projection', () => {
  const result = { text: 'set_window_frame: window_id 12345 is maximized; restore it before setting its frame',
    images: [], isError: true, structuredJson: JSON.stringify({ refusal: { code: 'window_maximized' },
      escalation: { recommended: 'foreground', reason: 'route unavailable' } }) } as unknown as sdk.ToolResult
  const projected = projectDriverAction(result)
  assert.equal(projected.status, 'refused'); assert.equal(projected.code, 'window_maximized')
  assert.match(projected.driverMessage!, /is maximized; restore/)
  assert.doesNotMatch(projected.driverMessage!, /12345/)
  assert.deepEqual(projected.diagnostics?.driver, { escalation: { recommended: 'foreground', reason: 'route unavailable' } })
})

test('Cua native geometry preserves raw physical frames and screenshot scale, including window borders', () => {
  const window: NativeWindow = { pid: 71, windowId: '99', title: 'fixture', app: 'fixture', minimized: false,
    bounds: { x: 200, y: 160, width: 500, height: 400 } }
  const state = { elements: [{ elementIndex: 1, elementToken: 's12345678:1', role: 'Edit', frame: { x: 250, y: 220, w: 50, h: 30 } }],
    images: [], screenshotWidth: 484, screenshotHeight: 384, screenshotScale: 1, snapshotId: 's12345678' } as unknown as sdk.WindowStateOutput
  const result = projectNativeObservation(window, state)
  assert.deepEqual(result.elements[0]!.frame, { x: 250, y: 220, width: 50, height: 30 })
  assert.equal(result.width, 484); assert.equal(result.scale, 1); assert.equal(result.snapshot, 's12345678')
})

test('partial, unverifiable and refused SDK results retain distinct host outcomes', () => {
  const result = (effect: number, isError = false) => ({ text: '', images: [], isError, action: { effect, route: 2 } } as unknown as sdk.ToolResult)
  assert.equal(projectDriverAction(result(0)).status, 'verified')
  for (const effect of [1, 2, 3]) assert.equal(projectDriverAction(result(effect)).status, 'unknown')
  assert.equal(projectDriverAction(result(4)).status, 'refused')
})

test('public Cua session labels are privately scoped and lifecycle lists exclude foreign sessions', () => {
  const a = new CuaSessionNames('private-a'), b = new CuaSessionNames('private-b')
  const first = a.resolve('research'), other = b.resolve('research')
  assert.notEqual(first, other)
  assert.deepEqual(JSON.parse(a.project(JSON.stringify({ sessions: [{ session: first }, { session: other }] }), true)), { sessions: [{ session: 'research' }] })
  assert.deepEqual(JSON.parse(a.project(JSON.stringify({ result: { session: first } }))), { result: { session: first } })
})

test('scope release cancels and drains FFI before shutdown, without destroying another scope', async () => {
  let closes = 0, finish!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const scopes = new CuaWorkerScopes(async () => ({ close: async () => { closes++ } } as DesktopDriver))
  const controller = new AbortController()
  const running = scopes.run('a', controller, async () => { entered(); await blocked })
  await ready
  await scopes.run('b', new AbortController(), async () => {})
  const releasing = scopes.release('a')
  assert.equal(controller.signal.aborted, true); assert.equal(closes, 0)
  await assert.rejects(scopes.run('a', new AbortController(), async () => {}), /正在释放/)
  finish(); await running; await releasing; assert.equal(closes, 1)
  await scopes.close(); assert.equal(closes, 2)
})

test('client generation changes for either worker restart or revived native session', async () => {
  let processGeneration = 1, nativeGeneration = 1
  const scopes: string[] = []
  const client = new CuaDriverClient({ prepare: async () => processGeneration,
    request: async (_name, _args, _signal, _input, scope) => { scopes.push(scope!); return nativeGeneration } }, 'private.scope').driver()
  const signal = new AbortController().signal
  assert.equal(await client.prepare!(signal), 1); assert.equal(await client.prepare!(signal), 1)
  nativeGeneration++; assert.equal(await client.prepare!(signal), 2)
  processGeneration++; nativeGeneration = 1; assert.equal(await client.prepare!(signal), 3)
  assert.ok(scopes.every(scope => scope === 'private.scope'))
})
