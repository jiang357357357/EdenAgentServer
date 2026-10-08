import type { JsonValue } from '@eden/api'
import type { SessionInput } from '../contracts.ts'

function metadataRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function transientTurnInput(metadata: JsonValue | undefined): boolean {
  return metadataRecord(metadata).internalHandoff === true
}

export function turnRecallQuery(input: SessionInput): string {
  const metadata = metadataRecord(input.metadata)
  const job = metadataRecord(metadata.job)
  if (job.kind !== 'self_awake') return input.text
  return typeof metadata.recallQuery === 'string' ? metadata.recallQuery : ''
}

export function runtimeStopReason(response: unknown): string | undefined {
  const value = typeof response === 'object' && response !== null && !Array.isArray(response)
    ? response as Record<string, unknown> : {}
  return value.stopReason === 'error' || value.stopReason === 'aborted'
    ? String(value.errorMessage ?? value.stopReason) : undefined
}
