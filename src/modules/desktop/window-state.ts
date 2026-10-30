import { setTimeout as delay } from 'node:timers/promises'
import { toJson } from '@eden/api'
import type { DesktopIdentity, DriverAction, InputObserver, NativeWindow } from './contracts.ts'
import { actionExecution, actionStatus, type Verification } from './action-outcome.ts'
import { DESKTOP_RESULT_MESSAGES } from '../../model-prompts/desktop-results.ts'

export async function confirmWindowState(observer: Pick<InputObserver, 'identify'>, window: NativeWindow, identity: DesktopIdentity,
  requested: string, action: DriverAction, signal: AbortSignal) {
  try {
    let current = await observer.identify(window)
    for (let attempt = 0; attempt < 10 && matches(current, requested) === false; attempt++) {
      await delay(50, undefined, { signal }); current = await observer.identify(window)
    }
    const matched = current.started === identity.started ? matches(current, requested) : undefined
    const verification: Verification = { state: matched === true ? 'confirmed' : matched === false ? 'mismatch' : 'unavailable',
      scope: 'native_window_state', evidence: [{ requested, ...state(current), sameProcess: current.started === identity.started }] }
    return { value: toJson({ kind: 'action', ...action, execution: actionExecution(action), verification,
      status: actionStatus(action, verification), requestedState: requested, observedState: state(current),
      message: matched ? DESKTOP_RESULT_MESSAGES.windowMatched : DESKTOP_RESULT_MESSAGES.windowUnmatched,
      nextAction: matched ? 'observe_window' : 'check_window_state' }) }
  } catch {
    signal.throwIfAborted()
    const verification: Verification = { state: 'unavailable', scope: 'native_window_state', evidence: [] }
    return { value: toJson({ kind: 'action', ...action, execution: actionExecution(action), verification,
      status: actionStatus(action, verification), requestedState: requested, nextAction: 'observe_window' }) }
  }
}
function matches(identity: DesktopIdentity, action: string): boolean | undefined {
  if (action === 'activate') return identity.foreground
  if (action === 'minimize') return identity.minimized
  if (action === 'maximize') return identity.maximized
  return identity.minimized === undefined || identity.maximized === undefined ? undefined : !identity.minimized && !identity.maximized
}
function state(identity: DesktopIdentity) {
  return { foreground: identity.foreground, minimized: identity.minimized ?? null, maximized: identity.maximized ?? null }
}
