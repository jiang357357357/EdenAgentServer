import { z } from 'zod'
import type { NativeObservation } from './contracts.ts'
import { elementText, uniqueElement } from './element-text.ts'
import { treeComplete } from './observation-geometry.ts'
import type { Verification } from './action-outcome.ts'

export const locatorSchema = z.object({ role: z.string().min(1).max(200), label: z.string().max(1000),
  ancestors: z.array(z.object({ role: z.string().min(1).max(200), label: z.string().max(1000) }).strict()).max(12).optional() }).strict()
const expectation = z.object({ kind: z.enum(['present', 'absent', 'text_equals', 'text_contains']), locator: locatorSchema,
  text: z.string().max(16000).optional() }).strict().refine(value => !value.kind.startsWith('text_') || value.text !== undefined, '文字核验必须提供 text')
export const expectationsSchema = z.array(expectation).min(1).max(4).optional()

export function verifyExpectations(input: unknown, observation: NativeObservation): Verification | undefined {
  if (input === undefined) return
  const checks = expectationsSchema.parse(input)!
  const evidence = checks.map(check => evaluate(check, observation))
  return { state: evidence.every(item => item.matched === true) ? 'confirmed'
    : evidence.some(item => item.matched === false) ? 'mismatch' : 'unconfirmed', scope: 'expected_ui_state', evidence }
}
function evaluate(check: z.infer<typeof expectation>, observation: NativeObservation): Record<string, unknown> {
  const base = { kind: check.kind, target: check.locator }
  if (observation.degraded) return { ...base, matched: null, reason: 'degraded_observation' }
  try {
    const locator = { role: check.locator.role, label: check.locator.label,
      ...(check.locator.ancestors ? { ancestors: check.locator.ancestors } : {}) }
    const element = uniqueElement(locator, observation)
    if (check.kind === 'present') return { ...base, matched: true }
    if (check.kind === 'absent') return { ...base, matched: false }
    const value = elementText(element, observation, 16000)
    const matched = matchesText(check, value)
    return { ...base, matched, observedText: value.text, complete: value.complete, source: value.source }
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ELEMENT_NOT_FOUND'
    return { ...base, matched: missing && treeComplete(observation) ? check.kind === 'absent' : null, reason: missing ? 'not_observed' : 'target_ambiguous' }
  }
}
function matchesText(check: z.infer<typeof expectation>, value: ReturnType<typeof elementText>) {
  if (check.kind === 'text_equals') return value.complete ? value.text === check.text : null
  if (value.text?.includes(check.text!)) return true
  return value.complete ? false : null
}
