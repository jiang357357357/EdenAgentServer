import type { JsonValue } from '@eden/api'

export type HiddenValues = Set<string> | undefined
export type ModelResult = (value: JsonValue, input?: Record<string, unknown>, hidden?: Set<string>) => JsonValue

const businessIdentifierFields = new Set(['id', 'agentId', 'parentId', 'parentActorId', 'blobId', 'connectorId', 'fileId',
  'device_id', 'assistantId', 'assistantID', 'characterId', 'hostDeviceId', 'diaryId', 'recoveryId', 'refId', 'spaceId'])
const hostTraceFields = ['requestId', 'request_id', 'turnId', 'turn_id', 'callId', 'call_id', 'sessionId', 'session_id',
  'traceId', 'trace_id', 'operationId', 'operation_id', 'idempotencyKey', 'idempotency_key', 'sourceSessionId', 'rootSessionId', 'childSessionId']

/** A value used as an admitted business ID must not be erased from prose merely because a link reused it. */
export class ResultIdentifiers extends Set<string> {
  readonly business = new Set<string>()
}

export function resultObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具结果不符合已登记的业务对象契约')
  return value
}

/** Only fields explicitly classified by the owning host contract are tracked. */
export function hideFields(value: Record<string, JsonValue>, names: readonly string[], hidden: HiddenValues): void {
  if (!hidden) return
  for (const name of names) {
    const item = value[name]
    if (typeof item !== 'string' || item.length < 8) continue
    hidden.add(item)
    for (const part of item.split(':')) {
      if (/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(part) || /^call_[\w-]{8,}$/.test(part)) hidden.add(part)
    }
  }
}

export function resultFields(value: JsonValue, names: readonly string[], hidden?: Set<string>, privateNames: readonly string[] = []): Record<string, JsonValue> {
  const object = resultObject(value)
  hideFields(object, [...hostTraceFields, ...privateNames], hidden)
  return Object.fromEntries(names.filter(name => Object.hasOwn(object, name)).map(name => {
    const item = object[name]!
    if (hidden instanceof ResultIdentifiers && businessIdentifierFields.has(name) && typeof item === 'string') hidden.business.add(item)
    return [name, item]
  }))
}

export function resultList(value: JsonValue, project: (item: JsonValue) => JsonValue): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('工具结果不符合已登记的业务列表契约')
  return value.map(project)
}

/** User files, command output and third-party business payloads are intentionally opaque. */
export const businessContent: ModelResult = value => value
