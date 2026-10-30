import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { liveDesktopFixture, until } from './live-fixture.ts'

test('real Windows Cua compatibility and public tools against an owned disposable application',
  { skip: process.platform !== 'win32' || process.env.EDEN_DESKTOP_LIVE !== '1', timeout: 180000 }, async t => {
    const f = await liveDesktopFixture()
    const checks: Record<string, unknown>[] = []
    t.after(async () => {
      const evidence = path.resolve(process.env.EDEN_DESKTOP_LIVE_EVIDENCE ?? '.artifacts/desktop-real-20261024')
      try {
        await mkdir(evidence, { recursive: true })
        await writeFile(path.join(evidence, 'live.json'), JSON.stringify({ checks, fixturePid: f.pid, operations: f.operations(),
          control: f.control(), inputEvents: f.inputEvents, finalState: await f.state(),
          userDatabaseUsed: false, externalMessagesSent: false, inputTarget: 'owned WinForms fixture only' }, null, 2) + '\n')
      } finally { await f.close() }
    })
    const windows = (await f.call('desktop_list_windows', { query: f.title })).windows
    const target = windows.find((window: any) => window.title.endsWith(' A')).window
    const observe = () => f.call('desktop_observe', { window: target, include_text: true })
    const element = (state: any, label: string) => {
      const matches = state.elements.filter((value: any) => value.label === label)
      assert.equal(matches.length, 1, `Expected one ${label}`); return matches[0]
    }
    await t.test('SDK and physical observer agree on the scaled desktop and window screenshot', async () => {
      const screen = await f.call('cua_get_screen_size', {})
      const state = await observe()
      assert.deepEqual({ width: screen.data.width, height: screen.data.height }, state.geometry.primaryScreen)
      // Window capture may omit invisible borders; it must not be DPI-virtualized by 125%.
      assert.ok(Math.abs(state.screenshot.width - state.bounds.width) <= 32)
      assert.ok(Math.abs(state.screenshot.height - state.bounds.height) <= 32)
      checks.push({ name: 'physical-pixels', screen: screen.data, bounds: state.bounds, screenshot: state.screenshot })
    })
    await t.test('two window frame requests match independent application-owned DWM readback', async () => {
      for (const frame of [{ x: 240, y: 160, width: 620, height: 440 }, { x: 360, y: 200, width: 560, height: 420 }]) {
        const result = await f.call('desktop_window', { window: target, action: 'resize', ...frame })
        assert.equal(result.status, 'verified'); assert.equal(result.verification.state, 'confirmed')
        assert.equal(result.verification.scope, 'window_geometry')
        const state = await until(f.state, value => JSON.stringify(value.A.visibleBounds) === JSON.stringify(frame))
        assert.deepEqual(state.A.visibleBounds, frame)
        checks.push({ name: 'resize', requested: frame, observed: state.A.visibleBounds, verification: result.verification })
      }
    })
    await t.test('a maximized resize retains the upstream explanation and requires explicit restore', async () => {
      await f.call('desktop_window', { window: target, action: 'maximize' })
      await until(f.state, value => value.A.windowState === 'Maximized')
      const result = await f.call('desktop_window', { window: target, action: 'resize', x: 240, y: 160, width: 620, height: 440 })
      assert.equal(result.status, 'refused'); assert.match(result.driverMessage, /maximized.*restore/i)
      checks.push({ name: 'maximized-refusal', status: result.status, driverMessage: result.driverMessage })
      const restored = await f.call('desktop_window', { window: target, action: 'restore' })
      assert.equal(restored.verification.state, 'confirmed'); assert.equal(restored.observedState.maximized, false)
      await until(f.state, value => value.A.windowState === 'Normal')
    })
    await t.test('element click changes the application counter once', async () => {
      const state = await observe(), before = await f.state()
      const result = await f.call('desktop_click', { window: target, element: element(state, 'EdenApply').element })
      const after = await until(f.state, value => value.A.clicks === before.A.clicks + 1)
      assert.equal(after.B.clicks, 0)
      checks.push({ name: 'element-click', status: result.status, clicks: after.A.clicks })
    })
    await t.test('screenshot-coordinate click is accepted and changes the counter once', async () => {
      const state = await observe(), button = element(state, 'EdenApply'), before = await f.state()
      const x = (button.frame.x + button.frame.width / 2 - state.bounds.x) * state.screenshot.width / state.bounds.width
      const y = (button.frame.y + button.frame.height / 2 - state.bounds.y) * state.screenshot.height / state.bounds.height
      const result = await f.call('desktop_click', { window: target, x, y, screenshotId: state.screenshot.id })
      assert.notEqual(result.status, 'refused', result.driverMessage)
      const after = await until(f.state, value => value.A.clicks === before.A.clicks + 1)
      checks.push({ name: 'coordinate-click', x, y, status: result.status, clicks: after.A.clicks })
    })
    const inputCase = async () => {
      const state = await observe()
      const replaced = await f.call('desktop_type', { window: target, element: element(state, 'EdenInput').element, mode: 'replace', text: 'Eden real test' })
      assert.equal(replaced.verification.state, 'confirmed')
      await until(f.state, value => value.A.text === 'Eden real test')
      const input = element(await observe(), 'EdenInput')
      const inserted = await f.call('desktop_type', { window: target, element: input.element, delivery: 'foreground', text: '!', expectedTitle: f.title })
      assert.equal(inserted.execution.state, 'dispatched'); assert.equal(inserted.verification.state, 'confirmed')
      const after = await until(f.state, value => value.A.text.includes('!'))
      assert.equal(after.A.text.replace('!', ''), 'Eden real test'); assert.equal(after.A.text.split('!').length, 2)
      assert.equal(after.B.text, '')
      checks.push({ name: 'text-input', text: after.A.text, otherWindowText: after.B.text })
    }
    await t.test('native Cua references and element tokens also dispatch a real click', async () => {
      const listing = await f.call('cua_list_windows', {})
      const window = listing.data.windows.find((value: any) => value.title === `${f.title} A`)
      assert.ok(window)
      const state = await f.call('cua_get_window_state', { pid: window.pid, window_id: window.window_id })
      const button = state.data.elements.find((value: any) => value.label === 'EdenApply')
      assert.ok(button?.element_token)
      const before = await f.state()
      const result = await f.call('cua_click', { pid: window.pid, window_id: window.window_id, element_token: button.element_token })
      const after = await until(f.state, value => value.A.clicks === before.A.clicks + 1)
      checks.push({ name: 'native-click', status: result.status, clicks: after.A.clicks })
    })
    await t.test('a new turn rejects old references and recovers through explicit rediscovery', async () => {
      const another = f.anotherTurn()
      await assert.rejects(another('desktop_window', { window: target, action: 'activate' }), /重新查找窗口/)
      const listing = await another('desktop_list_windows', { query: f.title })
      const newTarget = listing.windows.find((value: any) => value.title.endsWith(' A')).window
      assert.notEqual(newTarget, target)
      const state = await another('desktop_observe', { window: newTarget, include_text: true })
      assert.equal(state.title, `${f.title} A`)
      checks.push({ name: 'reference-rediscovery', recovered: true })
    })
    await t.test('replace and foreground insertion land exactly once in the selected input', inputCase)
    await t.test('the model view completes input and apply using refreshed refs without redundant observe', async () => {
      const start = f.operations().length
      const listing = (await f.callModel('desktop_list_windows', { query: f.title })).value
      const window = listing.windows.find((value: any) => value.title.endsWith(' A')).window
      const observed = (await f.callModel('desktop_observe', { window, include_text: true })).value
      const typed = await f.callModel('desktop_type', { window, element: element(observed, 'EdenInput').element,
        mode: 'replace', text: 'Eden model contract' })
      assert.equal(typed.value.verification.state, 'confirmed'); assert.equal(typed.value.observationReady, true)
      assert.equal(typed.images.length, 0); assert.ok(typed.raw.images.length > 0)
      const before = await f.state()
      const applied = await f.callModel('desktop_click', { window, element: element(typed.value.observation, 'EdenApply').element,
        expect: [{ kind: 'present', locator: { role: 'Button', label: 'EdenApplied' } },
          { kind: 'present', locator: { role: 'TitleBar', label: `${f.title} updated A` } }] })
      if (applied.value.verification.state !== 'confirmed') t.diagnostic(JSON.stringify({ verification: applied.value.verification,
        nodes: applied.value.observation?.elements.map((node: any) => ({ role: node.role, label: node.label, value: node.value })) }))
      assert.equal(applied.value.verification.state, 'confirmed'); assert.equal(applied.value.verification.scope, 'expected_ui_state')
      assert.equal(applied.value.context.titleChanged, true); assert.equal(applied.images.length, 0)
      const after = await until(f.state, value => value.A.applied === 'Eden model contract' && value.A.text === '')
      assert.equal(after.A.clicks, before.A.clicks + 1); assert.equal(after.B.text, '')
      const actions = f.operations().slice(start).map(operation => operation.action)
      assert.deepEqual(actions, ['desktop_list_windows', 'desktop_observe', 'desktop_type', 'desktop_click'])
      // The upstream SDK may omit an empty Edit value. A separate read must not invent an empty string.
      const readback = (await f.callModel('desktop_read_text', { window, element: element(applied.value.observation, 'EdenInput').element })).value
      assert.equal(readback.text, null); assert.equal(readback.status, 'unavailable'); assert.equal(readback.complete, false)
      checks.push({ name: 'model-contract-workflow', actions, execution: applied.value.execution,
        verification: applied.value.verification, typedVerification: typed.value.verification,
        rawCharacters: JSON.stringify(applied.raw).length, modelCharacters: JSON.stringify(applied.value).length,
        modelImages: applied.images.length, auditImages: applied.raw.images.length, appState: after.A,
        missingEmptyValue: { status: readback.status, text: readback.text, complete: readback.complete } })
    })
  })
