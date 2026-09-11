import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { isObject } from './message-delta.ts'

const format = 'eden.request.content.v1'
const requestKinds = new Set(['model.request', 'director.model.request', 'memory.extraction.model_request'])
const referenceSchema = z.object({ path: z.array(z.union([z.string(), z.number().int().nonnegative().safe()])).min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) })
type Reference = z.infer<typeof referenceSchema>

/** Realm-local content addressing; public request snapshots remain complete and unchanged. */
export class RequestPersistence {
  constructor(private readonly database: EdenDatabase) {}

  encode(kind: string, payload: JsonValue): JsonValue {
    if (!requestKinds.has(kind) || !isObject(payload)) return payload
    if (!this.database.inTransaction) throw new Error('Request content requires the event transaction')
    const references: Reference[] = []
    const store = (value: JsonValue, path: Reference['path']): JsonValue => {
      const json = JSON.stringify(value)
      const hash = digest(json)
      const inserted = this.database.connection.prepare('INSERT OR IGNORE INTO request_contents(hash,content_json) VALUES (?,?)').run(hash, json)
      if (!inserted.changes && this.database.connection.prepare('SELECT content_json FROM request_contents WHERE hash=?').get(hash)?.content_json !== json)
        throw new Error('Corrupt existing request content')
      references.push({ path, hash })
      return null
    }
    const visit = (value: JsonValue, path: Reference['path']): JsonValue => {
      if (typeof value === 'string' && value.length >= 256) return store(value, path)
      if (Array.isArray(value)) return value.map((item, index) => {
        const next = [...path, index]
        // Stable historical messages and tool definitions are reused across requests.
        if (isObject(item) && JSON.stringify(item).length >= 512) return store(item, next)
        return visit(item, next)
      })
      if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]))
      return value
    }
    const stored = { ...payload }
    // Keep request ID, actor, model/provider and contextEstimate directly queryable by SQL.
    for (const key of ['payload', 'tools', 'snapshot']) if (Object.hasOwn(stored, key)) stored[key] = visit(stored[key]!, [key])
    if (!references.length) return payload
    return { ...stored, requestStorage: { format, references } }
  }

  restore(kind: string, payload: JsonValue): JsonValue {
    if (!requestKinds.has(kind) || !isObject(payload) || !isObject(payload.requestStorage)) return payload
    const storage = payload.requestStorage
    if (storage.format !== format || !Array.isArray(storage.references)) throw new Error('Unsupported request content format')
    const { requestStorage: _storage, ...rest } = payload
    const result = structuredClone(rest)
    for (const raw of storage.references) {
      const reference = referenceSchema.parse(raw)
      const row = this.database.connection.prepare('SELECT content_json FROM request_contents WHERE hash=?').get(reference.hash)
      if (!row || typeof row.content_json !== 'string' || digest(row.content_json) !== reference.hash) throw new Error('Missing or corrupt request content')
      let target: JsonValue = result
      for (const key of reference.path.slice(0, -1)) target = child(target, key)
      const key = reference.path.at(-1)!
      if (child(target, key) !== null) throw new Error('Invalid request content placeholder')
      Object.defineProperty(target, String(key), { value: JSON.parse(row.content_json), enumerable: true, configurable: true, writable: true })
    }
    return result
  }
}

function child(target: JsonValue, key: JsonValue): JsonValue {
  if ((typeof key !== 'string' && typeof key !== 'number') || !target || typeof target !== 'object' || !Object.hasOwn(target, key))
    throw new Error('Invalid request content path')
  return (target as Record<string | number, JsonValue>)[key]!
}

function digest(json: string): string { return createHash('sha256').update(json).digest('hex') }
