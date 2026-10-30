import { setTimeout as delay } from 'node:timers/promises'
import { toJson } from '@eden/api'
import type { Bounds, DesktopIdentity, DriverAction, InputObserver, NativeWindow } from './contracts.ts'
import { DesktopError } from './contracts.ts'
import { actionExecution, actionStatus, type Verification } from './action-outcome.ts'

const same = (a: Bounds, b: Bounds) => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) <= 1)

/** Read the DWM visible frame independently; GetWindowRect includes invisible resize borders. */
export async function confirmWindowFrame(observer: Pick<InputObserver, 'identify'>, window: NativeWindow, identity: DesktopIdentity,
  requested: Bounds, action: DriverAction, signal: AbortSignal) {
  try {
    let current = await observer.identify(window)
    for (let attempt = 0; attempt < 6 && !same(current.visibleBounds ?? current.bounds, requested) && action.status !== 'refused'; attempt++) {
      await delay(40, undefined, { signal }); current = await observer.identify(window)
    }
    if (current.started !== identity.started) throw new DesktopError('窗口进程在调整后已变化', 'WINDOW_REPLACED', 'unknown')
    const observed = current.visibleBounds ?? current.bounds
    const matched = same(observed, requested), refused = action.status === 'refused'
    const verification: Verification = { state: refused ? 'not_executed' : matched ? 'confirmed' : 'mismatch', scope: 'window_geometry',
      evidence: [{ requestedBounds: requested, observedBounds: observed }] }
    return { value: toJson({ kind: 'action', ...action, windowFrame: 'visible_window', requestedBounds: requested, observedBounds: observed,
      execution: actionExecution(action), status: actionStatus(action, verification),
      ...(refused ? {} : { message: matched ? '已读回确认窗口可见边界与请求一致' : '窗口可见边界与请求不符，请核对返回的实际位置和尺寸，禁止报告调整成功' }),
      verification, nextAction: matched ? 'observe_window' : 'check_geometry' }) }
  } catch {
    signal.throwIfAborted()
    const verification: Verification = { state: 'unavailable', scope: 'window_geometry', evidence: [] }
    return { value: toJson({ kind: 'action', ...action, execution: actionExecution(action), status: actionStatus(action, verification),
      windowFrame: 'visible_window', requestedBounds: requested, verification, nextAction: 'observe_window' }) }
  }
}
