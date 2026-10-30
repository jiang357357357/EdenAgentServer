import type { JsonValue } from '@eden/api'
import { isMediaPayloadField } from '@eden/api'
import { qqTraceKeys } from './qq-identifiers.ts'

/** Keep business values and media intact; remove only structured host bookkeeping. */
export function projectQqValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(projectQqValue)
  if (!value || typeof value !== 'object') return value
  // Parameter schemas describe the provider's business API, not host bookkeeping values.
  if (value.protocol === 'napcat-action.v1') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !qqTraceKeys.has(key) && key !== 'model_view')
    .map(([key, item]) => [key, isMediaPayloadField(key, value) || key === 'parameters' ? item : projectQqValue(item)]))
}

/** Prefer the original receipt over an older, lossy model_view when both are available. */
export function qqModelResult(result: JsonValue): JsonValue {
  if (result && typeof result === 'object' && !Array.isArray(result) && result.model_view !== undefined) {
    const view = result.model_view
    if (view && typeof view === 'object' && !Array.isArray(view)) return projectQqValue({ ...view, ...result })
    if (Object.keys(result).every(key => key === 'model_view' || qqTraceKeys.has(key))) return projectQqValue(view)
  }
  return projectQqValue(result)
}
