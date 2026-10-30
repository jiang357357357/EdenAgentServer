import type { DriverAction } from './contracts.ts'

export type ExecutionState = 'dispatched' | 'refused' | 'partial' | 'uncertain' | 'not_applicable'
export interface Verification {
  state: 'confirmed' | 'partial' | 'unconfirmed' | 'mismatch' | 'unavailable' | 'not_executed' | 'not_applicable'
  scope: string
  evidence: Record<string, unknown>[]
}
export function actionExecution(action: DriverAction) {
  let state: ExecutionState = 'dispatched'
  if (action.status === 'refused') state = 'refused'
  else if (action.effect === 'partial') state = 'partial'
  else if (action.status === 'unknown' && !['unverifiable', 'suspected_noop'].includes(action.effect ?? '')) state = 'uncertain'
  return { state, driverStatus: action.status, ...(action.route ? { route: action.route } : {}), ...(action.effect ? { driverEffect: action.effect } : {}) }
}
export function actionStatus(action: DriverAction, verification: Verification) {
  const execution = actionExecution(action)
  if (execution.state === 'refused') return 'refused'
  if (execution.state === 'partial' || execution.state === 'uncertain') return 'unknown'
  return verification.state === 'confirmed' ? 'verified' : 'delivered'
}
