import type { JsonValue } from '@eden/api'

type Path = (string | number)[]
export type MessagePatch = { path: Path; value?: JsonValue; append?: string; remove?: true }

export function messagePatches(previous: JsonValue, next: JsonValue, path: Path = []): MessagePatch[] {
  if (previous === next) return []
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous))
    return [{ path, append: next.slice(previous.length) }]
  if (Array.isArray(previous) && Array.isArray(next) && previous.length === next.length)
    return next.flatMap((value, index) => messagePatches(previous[index]!, value, [...path, index]))
  if (isObject(previous) && isObject(next)) {
    const patches: MessagePatch[] = []
    for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) patches.push({ path: [...path, key], remove: true })
    for (const [key, value] of Object.entries(next)) patches.push(...(Object.hasOwn(previous, key)
      ? messagePatches(previous[key]!, value, [...path, key]) : [{ path: [...path, key], value }]))
    return patches
  }
  return [{ path, value: next }]
}

export function applyMessagePatches(previous: JsonValue, patches: MessagePatch[]): JsonValue {
  let result = structuredClone(previous)
  for (const patch of patches) {
    if (!patch.path.length) { result = replacement(result, patch); continue }
    let target = result
    for (const key of patch.path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('Missing message delta path')
      target = (target as Record<string | number, JsonValue>)[key]!
    }
    if (!target || typeof target !== 'object') throw new Error('Invalid message delta target')
    const key = patch.path.at(-1)!
    if (patch.remove) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, { value: replacement((target as Record<string | number, JsonValue>)[key]!, patch),
      enumerable: true, configurable: true, writable: true })
  }
  return result
}

function replacement(previous: JsonValue, patch: MessagePatch): JsonValue {
  if (patch.append !== undefined) {
    if (typeof previous !== 'string') throw new Error('Invalid message delta append')
    return previous + patch.append
  }
  if (patch.value === undefined) throw new Error('Missing message delta value')
  return structuredClone(patch.value)
}

export function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
