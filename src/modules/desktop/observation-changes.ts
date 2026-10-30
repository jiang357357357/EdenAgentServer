import type { NativeObservation, NativeElement } from './contracts.ts'
import { elementLocator } from './element-text.ts'

export function observationChanges(before: NativeObservation | undefined, after: NativeObservation) {
  if (!before) return { available: false }
  const key = (element: NativeElement, state: NativeObservation) => JSON.stringify(elementLocator(element, state.elements))
  const previous = new Map(before.elements.map(element => [key(element, before), element.value]))
  const current = new Set(after.elements.map(element => key(element, after)))
  const added = after.elements.filter(element => !previous.has(key(element, after))).slice(0, 16).map(brief)
  const textChanged = after.elements.filter(element => previous.has(key(element, after)) && previous.get(key(element, after)) !== element.value).slice(0, 16).map(brief)
  const removed = before.elements.filter(element => !current.has(key(element, before))).slice(0, 16).map(brief)
  return { available: true, added, textChanged, removed, causalAttribution: 'not_established' }
}
function brief(element: NativeElement) {
  return { role: element.role, label: element.label.slice(0, 300), ...(element.valueAvailable ? { value: element.value.slice(0, 1000) } : {}) }
}
