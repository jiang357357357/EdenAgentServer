import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopFixture } from './fixture.ts'

test('cross-window drag validates foreground, occlusion and primary screen before native input', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const [source, destination] = (await a.call('desktop_list_windows', {})).windows
  await a.call('desktop_observe', { window: source.window }); await a.call('desktop_observe', { window: destination.window })
  const input = { window: source.window, toWindow: destination.window, fromX: 50, fromY: 50, toX: 50, toY: 50, durationMs: 600 }
  await assert.rejects(a.call('desktop_drag', { ...input, delivery: 'background' }), /foreground/)
  f.foreground('2')
  await assert.rejects(a.call('desktop_drag', { ...input, delivery: 'foreground' }), /激活源窗口/)
  f.foreground('1'); f.occlude(true)
  await assert.rejects(a.call('desktop_drag', { ...input, delivery: 'foreground' }), /遮挡/)
  f.occlude(false); f.windows[1]!.bounds.x = 2000
  await assert.rejects(a.call('desktop_drag', { ...input, delivery: 'foreground' }), /主屏幕/)
  assert.equal(f.calls.length, 0)
  f.windows[1]!.bounds.x = 800
  const identify = f.observer.identify
  f.observer.identify = async window => ({ ...await identify(window), coordinateSpace: 'unknown' })
  await assert.rejects(a.call('desktop_drag', { ...input, delivery: 'foreground' }), /物理像素坐标基准/)
  assert.equal(f.calls.length, 0); f.observer.identify = identify
  await a.call('desktop_drag', { ...input, delivery: 'foreground' })
  assert.deepEqual(f.calls[0], { name: 'drag', args: { scope: 'desktop', delivery_mode: 'foreground',
    from_x: 225, from_y: 25, to_x: 425, to_y: 25, duration_ms: 600 } })
})
