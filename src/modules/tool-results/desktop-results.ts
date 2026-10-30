import type { JsonValue } from '@eden/api'
import { resultObject } from './model-fields.ts'

const actionFields = ['kind', 'window', 'status', 'message', 'execution', 'verification', 'nextAction', 'observationReady',
  'context', 'changes', 'code', 'windowFrame', 'requestedBounds', 'observedBounds', 'requestedState', 'observedState', 'application', 'next', 'observationError']
const observationFields = ['window', 'application', 'title', 'foreground', 'bounds', 'screenshot', 'accessibility', 'capabilities', 'geometry', 'focused_element', 'truncated']
type ObjectValue = Record<string, JsonValue>
const object = (value: JsonValue | undefined): ObjectValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const pick = (value: ObjectValue, fields: string[]): ObjectValue => Object.fromEntries(fields.filter(key => key in value).map(key => [key, value[key]!]))

/** Full receipts stay in operation storage; both current and historical model views use this bounded projection. */
export function desktopResult(name: string, value: JsonValue, input: Record<string, unknown> = {}): JsonValue {
  const raw = resultObject(value)
  if (raw.error) return { error: raw.error }
  if (name === 'desktop_observe') return compactObservation(raw, input, 80)
  if (name === 'desktop_read_text') return pick(raw, ['kind', 'window', 'element', 'locator', 'status', 'text', 'source', 'complete', 'truncated',
    'context', 'referencesRenewed', 'screenshotRequiredForCoordinates'])
  if (name === 'desktop_list_windows') return { kind: 'observation', status: 'read', ...pick(raw, ['windows', 'truncated']), nextAction: 'choose_window_and_observe' }
  if (name.startsWith('cua_')) return nativeResult(name, raw, input)
  const output = pick(raw, actionFields)
  const verificationView = compactVerification(raw.verification)
  if (verificationView) output.verification = verificationView
  if (raw.changes) output.changes = compactChanges(raw.changes)
  const verification = object(raw.verification)
  if (verification?.state !== 'confirmed' || object(raw.execution)?.state !== 'dispatched') Object.assign(output, pick(raw, ['driverMessage', 'diagnostics', 'images']))
  const observed = object(raw.observation)
  if (observed) output.observation = compactObservation(observed, input, 24, raw)
  return output
}
function compactObservation(raw: ObjectValue, input: Record<string, unknown>, defaultLimit: number, action?: ObjectValue): JsonValue {
  const elements = Array.isArray(raw.elements) ? raw.elements.filter(item => object(item)).map(item => object(item)!) : []
  const query = typeof input.query === 'string' ? input.query.toLocaleLowerCase() : ''
  const candidates = elements.filter(item => !query || `${item.role ?? ''} ${item.label ?? ''} ${item.value ?? ''}`.toLocaleLowerCase().includes(query))
  const limit = typeof input.maxElements === 'number' ? Math.min(400, Math.max(1, input.maxElements)) : defaultLimit
  const changed = changesKeys(action)
  const ordered = action ? [...candidates].sort((a, b) => priority(b, changed) - priority(a, changed)) : candidates
  const result: JsonValue[] = []
  let characters = 0
  for (const entry of ordered.slice(0, limit)) {
    const node = compactElement(entry), length = JSON.stringify(node).length
    if (characters + length > (action ? 12000 : 24000)) break
    result.push(node); characters += length
  }
  const view = pick(raw, observationFields)
  if (object(view.focused_element)) view.focused_element = compactElement(object(view.focused_element)!)
  return { kind: 'observation', status: 'read', ...view, elements: result, totalObservedElements: elements.length,
    matchingElements: candidates.length, omittedElements: elements.length - result.length,
    outputTruncated: result.length < candidates.length, ...(raw.images ? { images: raw.images } : {}) }
}
function compactElement(raw: ObjectValue): JsonValue {
  const output = pick(raw, ['element', 'parent', 'role', 'actions', 'frame', 'valueAvailable', 'enabled'])
  for (const key of ['label', 'value']) {
    const value = raw[key]
    if (typeof value !== 'string' || key === 'value' && raw.valueAvailable === false && !value) continue
    const limit = key === 'label' ? 400 : 1000
    output[key] = value.slice(0, limit)
    if (value.length > limit || raw[`${key}Truncated`] === true) output[`${key}Truncated`] = true
  }
  const ancestors = object(raw.locator)?.ancestors
  if (Array.isArray(ancestors)) {
    const context = ancestors.flatMap(item => { const entry = object(item); return entry && entry.role !== 'Document' && entry.label ? [String(entry.label).slice(0, 200)] : [] })
    if (context.length) output.context = context
  }
  return output
}
function changesKeys(action?: ObjectValue) {
  const changes = object(action?.changes), keys = new Set<string>(), targets = new Set<string>()
  for (const kind of ['added', 'textChanged']) {
    const entries = changes?.[kind]
    if (Array.isArray(entries)) for (const item of entries) { const entry = object(item); if (entry) keys.add(`${entry.role}:${entry.label}`) }
  }
  const evidence = object(action?.verification)?.evidence
  if (Array.isArray(evidence)) for (const item of evidence) {
    const target = object(object(item)?.target)
    if (target) targets.add(`${target.role}:${target.label}`)
  }
  return { changed: keys, targets }
}
function priority(entry: ObjectValue, keys: ReturnType<typeof changesKeys>) {
  if (keys.targets.has(`${entry.role}:${entry.label}`)) return 6
  if (keys.changed.has(`${entry.role}:${entry.label}`)) return 5
  if (entry.role === 'Edit' || entry.valueAvailable === true) return 4
  if (Array.isArray(entry.actions) && entry.actions.some(action => ['invoke', 'set_value', 'select'].includes(String(action)))) return 3
  return entry.label ? 1 : 0
}
function nativeResult(name: string, raw: ObjectValue, input: Record<string, unknown>): JsonValue {
  const output = pick(raw, [...actionFields, 'data', 'text', 'referenceScope', 'images'])
  if (raw.kind === 'action' && object(raw.verification)?.state === 'confirmed' && object(raw.execution)?.state === 'dispatched') delete output.images
  if (raw.status === 'refused' || object(raw.verification)?.state !== 'confirmed') Object.assign(output, pick(raw, ['driverMessage', 'diagnostics']))
  const data = object(raw.data)
  if (['cua_get_window_state', 'cua_get_accessibility_tree'].includes(name) && Array.isArray(data?.elements)) {
    output.data = compactNativeTree(data, input)
    delete output.text
  }
  return output
}
function compactNativeTree(data: ObjectValue, input: Record<string, unknown>): JsonValue {
    const nodes = (data.elements as JsonValue[]).map(item => {
      const node = object(item)
      return node ? pick(node, ['element_index', 'element_token', 'parent_index', 'role', 'label', 'value', 'enabled', 'actions', 'frame']) : item
    })
    const maximum = typeof input.max_elements === 'number' ? Math.min(400, Math.max(1, input.max_elements)) : 80
    const limited: JsonValue[] = []; let size = 0
    for (const node of nodes.slice(0, maximum)) { const length = JSON.stringify(node).length; if (size + length > 24000) break; limited.push(node); size += length }
    return { ...Object.fromEntries(Object.entries(data).filter(([key]) => !['elements', 'tree_markdown', 'tree_text'].includes(key))),
      elements: limited, totalObservedElements: nodes.length, omittedElements: nodes.length - limited.length, outputTruncated: limited.length < nodes.length }
}

function compactChanges(value: JsonValue): JsonValue {
  const raw = object(value)
  if (!raw) return value
  return Object.fromEntries(Object.entries(raw).map(([key, entries]) => [key, Array.isArray(entries) ? entries.slice(0, 6).map(entry => {
    const node = object(entry)
    if (!node) return entry
    return Object.fromEntries(Object.entries(node).map(([field, text]) => [field, typeof text === 'string' ? text.slice(0, 240) : text]))
  }) : entries]))
}
function compactVerification(value: JsonValue | undefined): JsonValue | undefined {
  const raw = object(value)
  if (!raw) return value
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.slice(0, 4).map(item => {
    const entry = object(item)
    if (!entry) return item
    return Object.fromEntries(Object.entries(entry).map(([key, detail]) => {
      if (typeof detail === 'string' && detail.length > 400)
        return [key, { preview: detail.slice(0, 400), characters: detail.length, truncated: true }]
      if (key === 'target' && object(detail)) {
        const target = object(detail)!
        return [key, pick(target, ['role', 'label'])]
      }
      return [key, detail]
    }))
  }) : []
  return { ...raw, evidence }
}
