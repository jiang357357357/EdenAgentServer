import type { NativeObservation } from './contracts.ts'
import type { Verification } from './action-outcome.ts'
import { matchActionTarget, type ActionTarget } from './action-target.ts'

export function verifyTypedText(before: ActionTarget | undefined, input: Record<string, unknown>, observation: NativeObservation): Verification | undefined {
  if (!before || typeof input.text !== 'string') return
  try {
    const current = matchActionTarget(before, observation), value = current.text
    const evidence = [{ target: before.locator, text: value.text, source: value.source, complete: value.complete,
      beforeText: before.text.text, beforeComplete: before.text.complete }]
    if (input.mode === 'replace' && value.complete && value.text === input.text)
      return { state: 'confirmed', scope: 'accessible_value', evidence }
    if (input.mode !== 'replace' && before.text.complete && value.complete
      && typeof before.text.text === 'string' && typeof value.text === 'string' && singleInsertion(before.text.text, value.text, input.text))
      return { state: 'confirmed', scope: 'accessible_text_change', evidence }
    if (value.text?.includes(input.text)) return { state: 'partial', scope: 'target_text_presence', evidence }
    return { state: value.complete ? 'mismatch' : 'unconfirmed', scope: 'target_text', evidence }
  } catch {
    return { state: 'unconfirmed', scope: 'target_text', evidence: [{ target: before.locator, reason: 'target_missing_or_ambiguous' }] }
  }
}
function singleInsertion(before: string, after: string, text: string) {
  if (!text || after.length !== before.length + text.length) return false
  for (let at = after.indexOf(text); at >= 0; at = after.indexOf(text, at + 1))
    if (after.slice(0, at) + after.slice(at + text.length) === before) return true
  return false
}
