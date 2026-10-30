import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopError } from '../../../src/modules/desktop/contracts.ts'
import { desktopFixture } from './fixture.ts'

test('scaled capture reports both geometry spaces and forwards screenshot pixels exactly once', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver), identify = f.observer.identify.bind(f.observer)
  f.observer.identify = async w => ({ ...await identify(w), coordinateSpace: 'physical_screen_pixels', dpi: 144,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  f.driver.observe = async (w, s) => {
    const o = await observe(w, s)
    return { ...o, window: { ...o.window, bounds: { x: 800, y: 0, width: 800, height: 600 } },
      scale: 0.5, frameValid: true, degraded: false,
      elements: [{ ...o.elements[0]!, frame: { x: 820, y: 20, width: 100, height: 40 } }] }
  }
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref })
  assert.equal(o.screenshot.scale, 0.5); assert.equal(o.screenshot.frameValid, true)
  assert.equal(o.geometry.observerBounds.width, 400); assert.equal(o.geometry.driverBounds.width, 800)
  assert.equal(o.geometry.windowDpi, 144); assert.equal(o.geometry.screenshotPixelsPerDriverUnit.x, 0.5)
  assert.equal(o.geometry.screenshotPixelsPerObserverUnit.x, 1)
  assert.deepEqual(o.elements[0].windowIntersection, { x: 820, y: 20, width: 100, height: 40 })
  assert.equal(o.elements[0].intersectsWindow, true); assert.equal(o.capabilities.minWindowSize, null)
  assert.equal(o.capabilities.delivery.background, 'per_action')
  await a.call('desktop_click', { window: ref, x: 100, y: 50 })
  assert.equal(f.calls[0]!.args.x, 100); assert.equal(f.calls[0]!.args.y, 50)
  assert.equal(JSON.stringify(o).includes('private-'), false)
})

test('invalid frames block pixels and transmit diagnostic errors without blocking valid element actions', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async (w, s) => ({ ...await observe(w, s), frameValid: false, degraded: true, degradedReason: 'render_incomplete' })
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref })
  assert.equal(o.accessibility.degradedReason, 'render_incomplete')
  await assert.rejects(a.call('desktop_click', { window: ref, x: 10, y: 10 }), (error: DesktopError) => {
    assert.equal(error.code, 'SCREENSHOT_UNAVAILABLE'); assert.equal(error.toolOutcome, 'failed')
    assert.equal((error.diagnostics!.screenshot as any).frameValid, false)
    assert.match(error.message, /diagnostics/); return true
  })
  assert.equal(f.calls.length, 0)
  await a.call('desktop_click', { window: ref, element: o.elements[0].element })
  assert.equal(f.calls.length, 1)
})

test('driver refusal carries element geometry and unknown calls keep their outcome through the broker', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async (w, s) => {
    const o = await observe(w, s)
    return { ...o, elements: [{ ...o.elements[0]!, frame: { x: -100, y: -100, width: 10, height: 10 } }] }
  }
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref })
  f.driver.act = async () => ({ status: 'refused', code: 'element_not_visible', message: 'not visible' })
  const result = await a.call('desktop_click', { window: ref, element: o.elements[0].element })
  assert.equal(result.diagnostics.element.intersectsWindow, false)
  assert.equal(result.code, 'element_not_visible')
  const fresh = await a.call('desktop_observe', { window: ref })
  f.driver.act = async () => { throw new DesktopError('cannot verify', 'background_unavailable', 'unknown') }
  await assert.rejects(a.call('desktop_click', { window: ref, element: fresh.elements[0].element }, 'unknown-call'), (e: DesktopError) => {
    assert.equal(e.toolOutcome, 'unknown'); assert.equal(e.code, 'background_unavailable')
    assert.equal((e.diagnostics!.element as any).intersectsWindow, false); return true
  })
  const recorded = a.database.connection.prepare('SELECT state,result_json FROM desktop_operations WHERE id=?').get(`${a.turnId}:unknown-call`) as any
  assert.equal(recorded.state, 'unknown'); assert.equal(JSON.parse(recorded.result_json).code, 'background_unavailable')
})

test('failed snapshots and movement during observation invalidate previous references', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const before = await a.call('desktop_observe', { window: ref }), observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async () => { throw new DesktopError('fixture capture failed') }
  await assert.rejects(a.call('desktop_observe', { window: ref }), /capture failed/)
  await assert.rejects(a.call('desktop_click', { window: ref, element: before.elements[0].element }), /先观察/)
  f.driver.observe = async (w, s) => { const o = await observe(w, s); f.windows[0]!.bounds.x++; return o }
  await assert.rejects(a.call('desktop_observe', { window: ref }), /观察期间窗口发生变化/)
  assert.equal(f.calls.length, 0)
})

test('DPI changes require a fresh observation and diagnostics report the current window context', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const identify = f.observer.identify.bind(f.observer)
  let dpi = 96
  f.observer.identify = async w => ({ ...await identify(w), dpi })
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  await a.call('desktop_observe', { window: ref })
  dpi = 144
  await assert.rejects(a.call('desktop_click', { window: ref, x: 10, y: 10 }), (e: DesktopError) => {
    assert.equal(e.code, 'WINDOW_CHANGED'); assert.equal((e.diagnostics!.geometry as any).windowDpi, 144); return true
  })
  assert.equal(f.calls.length, 0)
  await a.call('desktop_observe', { window: ref })
  await a.call('desktop_click', { window: ref, x: 10, y: 10 })
  assert.equal(f.calls.length, 1)
})
