import { toJson } from '@eden/api'
import type { DesktopDriver, DesktopResult, DriverAction, NativeObservation } from './contracts.ts'
import { DesktopError } from './contracts.ts'
import type { WindowTargets } from './window-targets.ts'
import { actionExecution, actionStatus, type Verification } from './action-outcome.ts'
import { captureActionTarget } from './action-target.ts'
import { verifyTypedText } from './action-text-verification.ts'
import { verifyExpectations } from './action-expectations.ts'
import { observationChanges } from './observation-changes.ts'
import { DESKTOP_RESULT_MESSAGES } from '../../model-prompts/desktop-results.ts'

/** Dispatch facts and observed effects have different owners. Never replay input to obtain proof. */
export async function confirmDesktopAction(targets: WindowTargets, driver: DesktopDriver, input: Record<string, unknown>,
  action: DriverAction, signal: AbortSignal, tool: string): Promise<DesktopResult> {
  const before = targets.get(input.window), oldState = before.observation, oldTitle = before.window.title
  const selected = captureActionTarget(before, input)
  const execution = actionExecution(action)
  try {
    signal.throwIfAborted()
    const observation = await targets.observe(String(input.window), driver, signal, { screenshot: true, text: true })
    const current = targets.get(input.window)
    let verification = verificationForAction(action, tool, input, current.observation!, () => verifyTypedText(selected, input, current.observation!))
    if (typeof input.expectedTitle === 'string' && !current.window.title.includes(input.expectedTitle)) {
      verification = { state: 'mismatch', scope: 'expected_title', evidence: [{ expected: input.expectedTitle, actual: current.window.title }] }
      targets.consume(current)
    }
    return { value: toJson({ kind: 'action', window: input.window, ...action, status: actionStatus(action, verification), execution, verification,
      message: verification.state === 'confirmed' ? DESKTOP_RESULT_MESSAGES.confirmed : verification.state === 'partial'
        ? DESKTOP_RESULT_MESSAGES.partial : action.status === 'refused' ? action.message : DESKTOP_RESULT_MESSAGES.unconfirmed,
      nextAction: nextAction(verification), observationReady: !current.consumed,
      ...(oldTitle !== current.window.title ? { context: { titleChanged: true, beforeTitle: oldTitle, title: current.window.title } } : {}),
      changes: observationChanges(oldState, current.observation!), observation: observation.value }), images: observation.images }
  } catch (error) {
    signal.throwIfAborted()
    const verification: Verification = { state: 'unavailable', scope: 'post_action_observation', evidence: [] }
    return { value: toJson({ kind: 'action', window: input.window, ...action, status: actionStatus(action, verification), execution, verification,
      message: DESKTOP_RESULT_MESSAGES.unavailable, nextAction: 'observe_window', observationReady: false,
      observationError: error instanceof DesktopError ? { code: error.code, message: error.message } : { code: 'POST_ACTION_OBSERVATION_FAILED' } }) }
  }
}

function verificationForAction(action: DriverAction, tool: string, input: Record<string, unknown>, observation: NativeObservation,
  text: () => Verification | undefined): Verification {
  if (action.status === 'refused') return { state: 'not_executed', scope: 'dispatch', evidence: [] }
  const expected = verifyExpectations(input.expect, observation)
  if (expected) return expected
  if (tool === 'desktop_type') {
    const read = text()
    if (read) return read
  }
  return action.status === 'verified' ? { state: 'confirmed', scope: 'driver_action', evidence: [{ source: 'driver', kinds: action.evidence ?? [] }] }
    : { state: 'unconfirmed', scope: 'action_effect', evidence: [] }
}
function nextAction(verification: Verification) {
  if (verification.state === 'confirmed') return 'continue_from_observation'
  if (verification.state === 'not_executed') return 'choose_supported_action'
  if (verification.state === 'mismatch') return 'check_target_and_observation'
  return 'inspect_returned_observation'
}
