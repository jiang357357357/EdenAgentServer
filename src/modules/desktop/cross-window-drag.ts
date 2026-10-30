import { DesktopError, type DesktopDriver, type InputObserver } from './contracts.ts'
import type { WindowTargets } from './window-targets.ts'

export async function crossWindowDrag(targets: WindowTargets, driver: DesktopDriver, observer: InputObserver,
  input: Record<string, unknown>, signal: AbortSignal) {
  if (input.delivery !== 'foreground') throw new DesktopError('跨窗口拖放需要显式选择 foreground，并先激活源窗口', 'FOREGROUND_REQUIRED')
  if (!observer.hit) throw new DesktopError('当前驱动不支持跨窗口拖放', 'CROSS_WINDOW_DRAG_UNAVAILABLE')
  const source = (await targets.input(input)).target
  const destination = (await targets.input({ window: input.toWindow, delivery: 'foreground' })).target
  if (source.observation?.captureBackend === 'cua_driver_native')
    throw new DesktopError('跨窗口拖放请使用 cua_get_desktop_state 获取桌面截图，再调用 cua_drag(scope=desktop)；窗口截图的裁剪原点不能推测为桌面原点', 'DESKTOP_SNAPSHOT_REQUIRED')
  targets.assertScreenshot(source, input.screenshotId); targets.assertScreenshot(destination, input.toScreenshotId)
  targets.pixel(source, input.fromX, input.fromY); targets.pixel(destination, input.toX, input.toY)
  if (!source.identity.foreground) throw new DesktopError('请先激活源窗口并重新观察两个窗口', 'FOREGROUND_REQUIRED')
  const physical = source.identity.screen
  if (!physical) throw new DesktopError('缺少当前屏幕的坐标映射', 'SCREEN_MAPPING_UNAVAILABLE')
  if (source.identity.coordinateSpace !== 'physical_screen_pixels' || destination.identity.coordinateSpace !== 'physical_screen_pixels')
    throw new DesktopError('系统观察器尚未确认物理像素坐标基准，请更新桌面服务后重新观察', 'SCREEN_MAPPING_UNAVAILABLE')
  const point = (target: typeof source, x: unknown, y: unknown) => ({
    x: target.identity.bounds.x + Number(x) * target.identity.bounds.width / target.observation!.width,
    y: target.identity.bounds.y + Number(y) * target.identity.bounds.height / target.observation!.height,
  })
  const from = point(source, input.fromX, input.fromY), to = point(destination, input.toX, input.toY)
  assertPrimaryScreen([from, to], physical)
  if (!await observer.hit(source.window, from.x, from.y) || !await observer.hit(destination.window, to.x, to.y))
    throw new DesktopError('源位置或目标位置被其他窗口遮挡，请调整窗口后重新观察', 'WINDOW_OCCLUDED')
  signal.throwIfAborted()
  if (source.observation!.snapshot && destination.observation!.snapshot) {
    const args = { pid: source.window.pid, window_id: source.window.windowId, snapshot: source.observation!.snapshot,
      to_pid: destination.window.pid, to_window_id: destination.window.windowId, to_snapshot: destination.observation!.snapshot,
      delivery_mode: 'foreground', from_x: input.fromX, from_y: input.fromY, to_x: input.toX, to_y: input.toY, duration_ms: input.durationMs }
    targets.consume(source); targets.consume(destination)
    return driver.act('drag', args, signal)
  }
  if (!driver.screenSize) throw new DesktopError('当前驱动不支持跨窗口拖放', 'CROSS_WINDOW_DRAG_UNAVAILABLE')
  const screen = await driver.screenSize(signal)
  return driver.act('drag', { scope: 'desktop', delivery_mode: 'foreground',
    from_x: from.x * screen.width / physical.width, from_y: from.y * screen.height / physical.height,
    to_x: to.x * screen.width / physical.width, to_y: to.y * screen.height / physical.height, duration_ms: input.durationMs }, signal)
}

function assertPrimaryScreen(points: { x: number; y: number }[], physical: { width: number; height: number }) {
  for (const p of points) if (p.x < 0 || p.y < 0 || p.x >= physical.width || p.y >= physical.height)
    throw new DesktopError('跨窗口拖放当前只支持主屏幕；请把两个窗口移到主屏幕后重新观察', 'CROSS_DISPLAY_DRAG_UNSUPPORTED')
}
