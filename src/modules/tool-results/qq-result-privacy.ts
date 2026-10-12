import type { JsonValue } from '@eden/api'
import { qqIdentifierHidden, qqReferenceDescription } from '../../model-prompts/qq-results.ts'
import { isQqReference, qqIdentifierKind, qqTraceKeys } from './qq-identifiers.ts'

type Identifier = (kind: string, value: string | number) => JsonValue

/** Schemas contain identifier field names, not identifier values; project them separately. */
export function qqReferenceSchema(value: JsonValue, field?: string): JsonValue {
  if (Array.isArray(value)) return value.map(item => qqReferenceSchema(item))
  if (!value || typeof value !== 'object') return value
  if (field && qqIdentifierKind(field)) {
    const reference = { type: 'string', pattern: '^qqref:[a-z]+:[1-9][0-9]*$', description: qqReferenceDescription }
    return value.type === 'array' ? { ...value, items: reference } : reference
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'properties' && item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, qqReferenceSchema(schema, name)]))
      : qqReferenceSchema(item)]))
}

export function projectQqValue(value: JsonValue, identifier: Identifier = () => qqIdentifierHidden, segment?: string, catalog = false): JsonValue {
  if (Array.isArray(value)) return value.map(item => projectQqValue(item, identifier, segment, catalog))
  if (!value || typeof value !== 'object') return value
  const type = typeof value.type === 'string' ? value.type : segment
  const inCatalog = catalog || value.protocol === 'napcat-action.v1'
  const entries: [string, JsonValue][] = []
  for (const [key, item] of Object.entries(value)) {
    if (qqTraceKeys.has(key) || key === 'model_view') continue
    const kind = qqIdentifierKind(key, type)
    if (kind) entries.push([key, projectIdentifier(item, kind, identifier, type, inCatalog)])
    else entries.push([key, inCatalog && key === 'parameters' ? qqReferenceSchema(item)
      : projectQqValue(item, identifier, key === 'resource_ids' ? 'resources' : type, inCatalog)])
  }
  return Object.fromEntries(entries)
}

function projectIdentifier(value: JsonValue, kind: string, identifier: Identifier, segment: string | undefined, catalog: boolean): JsonValue {
  if (Array.isArray(value)) return value.map(item => projectIdentifier(item, kind, identifier, segment, catalog))
  if (value === '' || isQqReference(value)) return value
  if (typeof value === 'string' || typeof value === 'number') return identifier(kind, value)
  return projectQqValue(value, identifier, segment, catalog)
}

/** Raw receipts stay in audit callbacks; only this view is serialized into model content. */
export function qqModelResult(result: JsonValue): JsonValue {
  if (result && typeof result === 'object' && !Array.isArray(result) && result.model_view !== undefined) return result.model_view
  return projectQqValue(result)
}
