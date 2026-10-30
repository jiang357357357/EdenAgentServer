import type { DriverAction } from './contracts.ts'
import { actionExecution, actionStatus, type Verification } from './action-outcome.ts'
import { DESKTOP_RESULT_MESSAGES } from '../../model-prompts/desktop-results.ts'

export function nativeOutcome(result: DriverAction, readOnly: boolean) {
  const readSucceeded = readOnly && ['delivered', 'verified'].includes(result.status)
  const verification: Verification = { state: readOnly ? 'not_applicable' : actionVerification(result),
    scope: readOnly ? 'query' : 'driver_action', evidence: readOnly ? [] : [{ source: 'driver', kinds: result.evidence ?? [] }] }
  const facts = Object.fromEntries(['code', 'driverMessage', 'diagnostics', 'effect', 'route']
    .filter(key => key in result).map(key => [key, result[key as keyof DriverAction]]))
  return { kind: readOnly ? 'observation' : 'action', status: readSucceeded ? 'read' : actionStatus(result, verification),
    message: readSucceeded ? DESKTOP_RESULT_MESSAGES.read : result.message,
    execution: readSucceeded ? { state: 'not_applicable' } : actionExecution(result), verification,
    nextAction: readOnly ? 'use_returned_result' : 'verify_state_or_observe', ...facts }
}
function actionVerification(result: DriverAction): Verification['state'] {
  if (result.status === 'refused') return 'not_executed'
  return result.status === 'verified' ? 'confirmed' : 'unconfirmed'
}
