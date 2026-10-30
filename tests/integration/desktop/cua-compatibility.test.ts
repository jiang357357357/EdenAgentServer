import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopFixture } from './fixture.ts'
import { DesktopError } from '../../../src/modules/desktop/contracts.ts'

async function fixture() {
  const f = await desktopFixture()
  let generation = 0
  f.windows[0]!.bounds = { x: 720, y: 200, width: 1736, height: 1280 }
  const observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async (window, signal, options) => {
    const value = await observe(window, signal)
    const element = { ...value.elements[0]!, frame: { x: 762, y: 256, width: 60, height: 20 } }
    return { ...value, window: { ...value.window, title: f.windows.find(item => item.windowId === window.windowId)!.title },
      snapshot: `s${(++generation).toString(16).padStart(8, '0')}`, elements: options?.text === false ? [] : [element],
      elementCoordinateSpace: 'physical_screen_pixels', captureBackend: 'cua_driver_native',
      width: 868, height: 640, scale: 0.5, frameValid: true, screenshotIncluded: options?.screenshot !== false,
      textRequested: options?.text ?? false }
  }
  const act = f.driver.act.bind(f.driver)
  f.driver.act = async (...args) => { await act(...args); return { status: 'delivered', route: 'global_input', message: 'fixture input dispatched' } }
  const a = f.account(); a.permissions.setMode('full_access')
  const window = (await a.call('desktop_list_windows', {})).windows[0].window
  return { ...f, a, window }
}

test('Cua preserves physical element frames and exposes a screenshot binding with opt-in accessibility', async t => {
  const f = await fixture(); t.after(() => f.close())
  const visual = await f.a.call('desktop_observe', { window: f.window })
  assert.equal(visual.elements.length, 0)
  assert.equal(visual.capabilities.delivery.background, 'default_per_action')
  assert.equal(visual.capabilities.captureBackend, 'cua_driver_native')
  assert.match(visual.screenshot.id, /^screenshot-[a-f0-9]{16}$/)
  assert.equal(visual.geometry.screenshotPixelsPerDriverUnit.x, 0.5)
  const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  assert.equal(state.capabilities.elementFrameCoordinateSpace, 'physical_screen_pixels')
  assert.equal(state.elements[0].intersectsWindow, true)
  assert.deepEqual(state.elements[0].windowIntersection, { x: 762, y: 256, width: 60, height: 20 })
  assert.equal(state.focused_element, null)
  assert.doesNotMatch(JSON.stringify(state), /private-|"snapshot"/)
})

test('coordinate input rejects missing or stale screenshots before dispatch and passes current pixels once', async t => {
  const f = await fixture(); t.after(() => f.close())
  const before = await f.a.call('desktop_observe', { window: f.window })
  await assert.rejects(f.a.call('desktop_click', { window: f.window, x: 50, y: 60 }), /screenshotId/)
  const current = await f.a.call('desktop_observe', { window: f.window })
  await assert.rejects(f.a.call('desktop_click', { window: f.window, x: 50, y: 60, screenshotId: before.screenshot.id }), /screenshotId/)
  assert.equal(f.calls.length, 0)
  const result = await f.a.call('desktop_click', { window: f.window, x: 50, y: 60, screenshotId: current.screenshot.id })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.args.x, 50); assert.equal(f.calls[0]!.args.y, 60)
  assert.equal(f.calls[0]!.args.delivery_mode, 'background')
  assert.equal(f.calls[0]!.args.snapshot, undefined)
  assert.notEqual(result.observation.screenshot.id, current.screenshot.id)
})

test('conversation mismatch is explicit rather than reporting any visual change as success', async t => {
  const f = await fixture(); t.after(() => f.close())
  const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  const act = f.driver.act.bind(f.driver)
  f.driver.act = async (...args) => { const result = await act(...args); f.windows[0]!.title = 'Game group'; return result }
  const result = await f.a.call('desktop_click', { window: f.window, element: state.elements[0].element, expectedTitle: 'Xiaochenxing' })
  assert.equal(result.verification.state, 'mismatch'); assert.equal(result.status, 'delivered')
  assert.equal(result.verification.scope, 'expected_title')
  assert.deepEqual(result.verification.evidence, [{ expected: 'Xiaochenxing', actual: 'Game group' }])
  assert.equal(result.observationReady, false)
  await assert.rejects(f.a.call('desktop_type', { window: f.window, element: result.observation.elements[0].element, text: 'must stop' }), /重新观察/)
  assert.equal(f.calls.length, 1)
})

test('new backend generation invalidates old observations before any input is sent', async t => {
  const f = await fixture(); t.after(() => f.close())
  let generation = 1
  f.driver.prepare = async () => generation
  const old = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  generation++
  await assert.rejects(f.a.call('desktop_click', { window: f.window, element: old.elements[0].element }), /重新观察/)
  assert.equal(f.calls.length, 0)
  const current = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  await f.a.call('desktop_click', { window: f.window, element: current.elements[0].element })
  assert.equal(f.calls.length, 1)
})

test('Cua cross-window compatibility refuses to infer the origin of cropped captures', async t => {
  const f = await fixture(); t.after(() => f.close())
  const windows = (await f.a.call('desktop_list_windows', {})).windows
  const source = await f.a.call('desktop_observe', { window: windows[0].window })
  const target = await f.a.call('desktop_observe', { window: windows[1].window })
  await assert.rejects(f.a.call('desktop_drag', { window: source.window, toWindow: target.window, fromX: 50, fromY: 50, toX: 50, toY: 50,
    screenshotId: source.screenshot.id, toScreenshotId: target.screenshot.id, delivery: 'foreground' }), /cua_get_desktop_state/)
  assert.equal(f.calls.length, 0)
})

test('an uncertain action consumes its observation; retry requires a new observation', async t => {
  const f = await fixture(); t.after(() => f.close())
  const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  let actions = 0
  f.driver.act = async () => { actions++; throw new DesktopError('partial', 'INPUT_PARTIAL', 'unknown') }
  await assert.rejects(f.a.call('desktop_click', { window: f.window, element: state.elements[0].element }), /partial/)
  await assert.rejects(f.a.call('desktop_click', { window: f.window, element: state.elements[0].element }), /重新观察/)
  assert.equal(actions, 1)
})

test('a refused action returns a fresh observation without replaying input or discarding driver diagnostics', async t => {
  const f = await fixture(); t.after(() => f.close())
  const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  let attempts = 0
  f.driver.act = async () => { attempts++; return { status: 'refused', code: 'background_unavailable', message: 'refused',
    driverMessage: 'Target does not support background input', diagnostics: { driver: { escalation: { recommended: 'foreground' } } } } }
  const refused = await f.a.call('desktop_click', { window: f.window, element: state.elements[0].element })
  assert.equal(attempts, 1); assert.equal(refused.status, 'refused'); assert.equal(refused.verification.state, 'not_executed')
  assert.equal(refused.driverMessage, 'Target does not support background input')
  assert.equal(refused.diagnostics.driver.escalation.recommended, 'foreground')
  assert.notEqual(refused.observation.elements[0].element, state.elements[0].element)
  await assert.rejects(f.a.call('desktop_click', { window: f.window, element: state.elements[0].element }), /引用已失效/)
  await f.a.call('desktop_click', { window: f.window, element: refused.observation.elements[0].element })
  assert.equal(attempts, 2)
})

test('foreign window references return rediscovery steps without selecting a guessed window', async t => {
  const f = await fixture(); t.after(() => f.close())
  await assert.rejects(f.a.call('desktop_window', { window: 'window-0000000000000000', action: 'activate' }),
    (error: unknown) => error instanceof DesktopError && error.code === 'WINDOW_REFERENCE_EXPIRED'
      && JSON.stringify(error.diagnostics?.recovery) === JSON.stringify(['desktop_list_windows', 'desktop_observe']))
  assert.equal(f.calls.length, 0)
})

test('text-only observations report absent screenshots without inventing a zero coordinate scale', async t => {
  const f = await fixture(); t.after(() => f.close())
  const state = await f.a.call('desktop_observe', { window: f.window, include_screenshot: false, include_text: true })
  assert.equal(state.screenshot.included, false); assert.equal(state.screenshot.usableForCoordinates, false)
  assert.equal(state.geometry.screenshotPixelsPerDriverUnit.x, null)
  assert.equal(state.elements[0].intersectsWindow, true)
})

test('title mismatch is checked before typing or pressing keys, even after a previous valid observation', async t => {
  const f = await fixture(); t.after(() => f.close())
  const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  for (const [name, extra] of [['desktop_type', { text: 'never send' }], ['desktop_key', { keys: ['enter'] }]] as const)
    await assert.rejects(f.a.call(name, { window: f.window, element: state.elements[0].element, expectedTitle: 'different recipient', ...extra }), /不匹配/)
  assert.equal(f.calls.length, 0)
})

test('a revived SDK session can activate a known window before reacquiring observations', async t => {
  const f = await fixture(); t.after(() => f.close())
  let generation = 1
  f.driver.prepare = async () => generation
  await f.a.call('desktop_observe', { window: f.window }); generation++
  await f.a.call('desktop_window', { window: f.window, action: 'activate' })
  assert.equal(f.calls.at(-1)!.name, 'bring_to_front')
  assert.equal((await f.a.call('desktop_observe', { window: f.window })).title, 'Fixture 1')
})

test('geometry disagreement is reported unknown rather than stretching UIA frames into the screenshot', async t => {
  const f = await fixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async (...args) => {
    const result = await observe(...args)
    result.window.bounds.width *= 2; result.window.bounds.height *= 2
    return result
  }
  const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
  assert.equal(state.geometry.elementFrameCoordinateSpace, 'unknown')
  assert.equal(state.elements[0].intersectsWindow, null)
  assert.deepEqual(state.elements[0].frame, { x: 762, y: 256, width: 60, height: 20 })
  await assert.rejects(f.a.call('desktop_click', { window: f.window, element: state.elements[0].element }), /几何不一致/)
  assert.equal(f.calls.length, 0)
})

test('single keys use press_key and combinations use hotkey', async t => {
  const f = await fixture(); t.after(() => f.close())
  for (const keys of [['enter'], ['ctrl', 's']]) {
    const state = await f.a.call('desktop_observe', { window: f.window, include_text: true })
    await f.a.call('desktop_key', { window: f.window, element: state.elements[0].element, keys })
  }
  assert.equal(f.calls[0]!.name, 'press_key'); assert.equal(f.calls[0]!.args.key, 'enter')
  assert.equal(f.calls[1]!.name, 'hotkey'); assert.deepEqual(f.calls[1]!.args.keys, ['ctrl', 's'])
})
