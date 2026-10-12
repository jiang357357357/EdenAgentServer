import { toJson, type JsonValue } from '@eden/api'
import { isQqReference, projectQqValue, qqIdentifierKind, qqTraceKeys } from '../tool-results/index.ts'
import type { NapcatSessionTarget } from './napcat-target.ts'
import { QqReferenceRepository } from './qq-reference-repository.ts'
import { qqIdentifierHidden } from '../../model-prompts/qq-results.ts'

export class QqActionResults {
  constructor(private readonly references: QqReferenceRepository) {}

  result(target: NapcatSessionTarget, raw: JsonValue): JsonValue {
    const known = this.references.known(target)
    return this.references.transaction(() => {
      const projected = projectQqValue(raw, (kind, value) => {
        const reference = this.references.remember(target, kind, value)
        known.set(String(value), reference)
        return reference
      })
      const receipt = object(raw)
      for (const key of qqTraceKeys) {
        const value = receipt[key]
        if (typeof value === 'string' && value) known.set(value, qqIdentifierHidden)
      }
      return toJson({ ...receipt, model_view: replaceKnown(projected, known) })
    })
  }

  params(target: NapcatSessionTarget, raw: Record<string, unknown>): Record<string, unknown> {
    const walk = (value: unknown, segment?: string): unknown => {
      if (Array.isArray(value)) return value.map(item => walk(item, segment))
      if (!value || typeof value !== 'object') return value
      const record = value as Record<string, unknown>, type = typeof record.type === 'string' ? record.type : segment
      return Object.fromEntries(Object.entries(record).map(([key, item]) => {
        const kind = qqIdentifierKind(key, type)
        if (qqTraceKeys.has(key)) throw new Error('QQ 模型参数不能包含宿主追踪标识')
        if (kind && item !== '' && item !== null) return [key, Array.isArray(item)
          ? item.map(id => this.references.resolve(target, kind, id)) : this.references.resolve(target, kind, item)]
        return [key, walk(item, key === 'resource_ids' ? 'resources' : type)]
      }))
    }
    return walk(raw) as Record<string, unknown>
  }
}

function object(value: JsonValue): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value } }

function replaceKnown(value: JsonValue, known: Map<string, string>): JsonValue {
  if (typeof value === 'string') {
    if (isQqReference(value)) return value
    let text = value
    for (const [raw, reference] of known) if (raw.length >= 6) text = text.split(raw).join(reference)
    return text
  }
  if (Array.isArray(value)) return value.map(item => replaceKnown(item, known))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceKnown(item, known)]))
}
