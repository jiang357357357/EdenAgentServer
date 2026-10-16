import { credentialValues, redactCredentialJson, toJson } from '@eden/api'
import type { MemoryRecord, JsonValue } from '@eden/api'
import { MEMORY_CREDENTIAL_HIDDEN } from '../../model-prompts/memory.ts'

export function safeMemoryRecord(value: MemoryRecord): MemoryRecord {
  const hidden = credentialValues(value.content).length > 0
  return { ...value, content: hidden ? MEMORY_CREDENTIAL_HIDDEN : value.content,
    metadata: redactCredentialJson(value.metadata) }
}

export function memoryModelResult(value: MemoryRecord): JsonValue {
  const safe = safeMemoryRecord(value)
  return toJson({ id: safe.id, content: safe.content, kind: safe.kind, createdAt: safe.createdAt, updatedAt: safe.updatedAt,
    credentialHidden: safe.content === MEMORY_CREDENTIAL_HIDDEN })
}

export function memoryApprovalRecord(value: MemoryRecord) {
  const safe = safeMemoryRecord(value)
  return { id: safe.id, kind: safe.kind, content: safe.content, updatedAt: safe.updatedAt }
}
