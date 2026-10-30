import { toJson, type JsonValue } from '@eden/api'
import { isQqReference, projectQqValue, qqIdentifierKind } from '../tool-results/index.ts'
import type { NapcatSessionTarget } from './napcat-target.ts'
import { QqReferenceRepository } from './qq-reference-repository.ts'

export class QqActionResults {
  constructor(private readonly references: QqReferenceRepository) {}

  result(raw: JsonValue): JsonValue {
    const receipt = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { result: raw }
    return toJson({ ...receipt, model_view: projectQqValue(raw) })
  }

  /** New calls use the provider's IDs directly; old checkpoint references remain resolvable. */
  params(target: NapcatSessionTarget, raw: Record<string, unknown>): Record<string, unknown> {
    const walk = (value: unknown, segment?: string): unknown => {
      if (Array.isArray(value)) return value.map(item => walk(item, segment))
      if (!value || typeof value !== 'object') return value
      const record = value as Record<string, unknown>, type = typeof record.type === 'string' ? record.type : segment
      return Object.fromEntries(Object.entries(record).map(([key, item]) => {
        const kind = qqIdentifierKind(key, type)
        const resolve = (id: unknown) => isQqReference(id) ? this.references.resolve(target, kind!, id) : id
        if (kind) return [key, Array.isArray(item) ? item.map(resolve) : resolve(item)]
        return [key, walk(item, key === 'resource_ids' ? 'resources' : type)]
      }))
    }
    return walk(raw) as Record<string, unknown>
  }
}
