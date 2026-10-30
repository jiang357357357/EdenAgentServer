import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopFixture, tick } from './fixture.ts'

test('task approval covers cross-window work and internal handles never enter model results', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account()
  const pending = a.call('desktop_list_windows', {})
  await tick()
  assert.equal(f.calls.length, 0)
  const request = a.permissions.list().find(r => r.state === 'pending')!
  assert.equal(request.capability, 'desktop.control'); a.permissions.resolve(request.id, true)
  const list = await pending
  assert.equal(list.windows.length, 2)
  assert.equal(JSON.stringify(list).includes('windowId'), false)
  for (const window of list.windows) {
    const state = await a.call('desktop_observe', { window: window.window })
    assert.equal(JSON.stringify(state).includes('private-'), false)
    const result = await a.call('desktop_type', { window: window.window, element: state.elements[0].element, text: window.title })
    assert.equal(result.status, 'verified')
    const after = await a.call('desktop_observe', { window: window.window })
    assert.equal(after.elements[0].value, window.title)
  }
  assert.equal(a.permissions.list().length, 1)
  assert.equal(f.values.size, 2)
})
test('window and element references stay within a session and expire on a new observation', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account('mon'), b = f.account('local')
  a.permissions.setMode('full_access'); b.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  await assert.rejects(b.call('desktop_observe', { window: ref }), /当前会话/)
  const old = await a.call('desktop_observe', { window: ref })
  await a.call('desktop_observe', { window: ref })
  await assert.rejects(a.call('desktop_click', { window: ref, element: old.elements[0].element }), /控件引用已失效/)
  assert.equal(f.calls.length, 0)
})
test('resized and replaced windows fail before native input; outside coordinates fail closed', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  await a.call('desktop_observe', { window: ref })
  await assert.rejects(a.call('desktop_click', { window: ref, x: 500, y: 20 }), /坐标/)
  f.windows[0]!.bounds.width = 600
  await assert.rejects(a.call('desktop_click', { window: ref, x: 20, y: 20 }), /窗口大小/)
  f.restart()
  await assert.rejects(a.call('desktop_observe', { window: ref }), /进程已被替换/)
  assert.equal(f.calls.length, 0)
})
test('denial has no desktop effects and duplicate operations are never replayed', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account()
  const pending = a.call('desktop_list_windows', {}); const denied = assert.rejects(pending, /denied/)
  await tick(); a.permissions.resolve(a.permissions.list().find(r => r.state === 'pending')!.id, false)
  await denied; assert.equal(f.calls.length, 0)
  a.permissions.setMode('full_access')
  await a.call('desktop_list_windows', {}, 'same-call')
  await assert.rejects(a.call('desktop_list_windows', {}, 'same-call'), /不能重放/)
})
test('stop is shared across worlds, clears task grants and requires an explicit resume', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account('mon'), b = f.account('local')
  a.permissions.setMode('full_access'); b.permissions.setMode('full_access')
  await a.call('desktop_list_windows', {}); await b.call('desktop_list_windows', {})
  const ref = (await b.call('desktop_list_windows', {})).windows[0].window
  const observation = await b.call('desktop_observe', { window: ref })
  await a.service.control('stop')
  assert.equal((await b.service.status()).stopped, true)
  await assert.rejects(b.call('desktop_list_windows', {}), /暂停或停止/)
  await b.service.control('resume')
  await assert.rejects(b.call('desktop_click', { window: ref, element: observation.elements[0].element }), /先观察/)
  assert.equal((await a.service.status()).stopped, false)
  assert.equal((await b.call('desktop_list_windows', {})).windows.length, 2)
})
