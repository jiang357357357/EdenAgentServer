import { DesktopError, type ElementLocator, type NativeElement, type NativeObservation } from './contracts.ts'
import { treeComplete } from './observation-geometry.ts'

export function elementLocator(element: NativeElement, elements: NativeElement[]): ElementLocator {
  const ancestors: { role: string; label: string }[] = [], seen = new Set<string>()
  let parent = element.parent
  while (parent !== undefined && ancestors.length < 12 && !seen.has(parent)) {
    seen.add(parent)
    const entry = elements.find(e => e.index === parent)
    if (!entry) break
    ancestors.unshift({ role: entry.role, label: entry.label }); parent = entry.parent
  }
  return { role: element.role, label: element.label, ...(ancestors.length ? { ancestors } : {}) }
}

export function uniqueElement(locator: ElementLocator, observation: NativeObservation): NativeElement {
  const matches = observation.elements.filter(e => {
    if (e.role !== locator.role || e.label !== locator.label) return false
    return !locator.ancestors || JSON.stringify(elementLocator(e, observation.elements).ancestors ?? []) === JSON.stringify(locator.ancestors)
  })
  if (matches.length !== 1) throw new DesktopError('文字目标缺失或不唯一，请重新观察并使用明确的角色、标签和祖先路径',
    matches.length ? 'ELEMENT_AMBIGUOUS' : 'ELEMENT_NOT_FOUND', 'failed', { matches: matches.length })
  if (matches[0]!.labelTruncated) throw new DesktopError('目标标签被截断，无法确认文字定位条件，请缩小观察范围', 'ELEMENT_LABEL_TRUNCATED')
  return matches[0]!
}

/** Only the OS window root may follow its independently observed title; business ancestors remain exact. */
export function refreshWindowLocator(locator: ElementLocator, beforeTitle: string, observation: NativeObservation): ElementLocator {
  const first = locator.ancestors?.[0]
  if (!first || first.role !== 'Window' || first.label !== beforeTitle || beforeTitle === observation.window.title) return locator
  const root = observation.elements.find(element => element.role === 'Window' && element.parent === undefined
    && element.label === observation.window.title && !element.labelTruncated)
  return root ? { ...locator, ancestors: [{ role: first.role, label: root.label }, ...locator.ancestors!.slice(1)] } : locator
}

export function elementText(element: NativeElement, observation: NativeObservation, maxChars: number) {
  if (element.valueAvailable === true || element.value !== '')
    return textValue(element.value, 'value', !element.valueTruncated, observation, maxChars, true)
  if (element.role === 'Text') return textValue(element.label, 'label', !element.labelTruncated, observation, maxChars, true)
  const descendants = new Set<string>(element.index === undefined ? [] : [element.index])
  const text: NativeElement[] = []
  // Breadth by parent link, independent of provider enumeration order. Each node is included once.
  for (let pass = 0; pass < observation.elements.length; pass++) {
    let changed = false
    for (const entry of observation.elements) {
      if (entry.index === undefined || entry.parent === undefined || descendants.has(entry.index) || !descendants.has(entry.parent)) continue
      descendants.add(entry.index); changed = true
      if (entry.role === 'Text') text.push(entry)
    }
    if (!changed) break
  }
  if (!text.length) return { text: null, source: 'unavailable', complete: false, truncated: false }
  return textValue(text.map(e => e.value || e.label).join('\n'), 'text_descendants',
    text.every(e => !e.valueTruncated && !e.labelTruncated), observation, maxChars)
}

function textValue(text: string, source: string, intact: boolean, observation: NativeObservation, maxChars: number, scalar = false) {
  const truncated = !intact || text.length > maxChars
  return { text: text.slice(0, maxChars), source, complete: !observation.degraded && (scalar || treeComplete(observation)) && !truncated, truncated }
}
