import type { JsonValue } from '@eden/api'
import type { SessionInput } from '../contracts.ts'

function metadataRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function transientTurnInput(metadata: JsonValue | undefined): boolean {
  return metadataRecord(metadata).internalHandoff === true
}

export function isCompanionInput(input: SessionInput): boolean {
  return Object.hasOwn(metadataRecord(input.metadata), 'companion')
}

/** A new diary round uses current conversation excerpts, not previous autonomous transcripts. */
export function isStandaloneSelfAwakeTurn(input: SessionInput): boolean {
  return input.kind !== 'compact' && ['self_awake', 'connector.event'].includes(String(metadataRecord(metadataRecord(input.metadata).job).kind))
}

export function turnRecallQuery(input: SessionInput): string {
  const metadata = metadataRecord(input.metadata)
  const job = metadataRecord(metadata.job)
  if (!['self_awake', 'connector.event'].includes(String(job.kind))) return input.text
  return typeof metadata.recallQuery === 'string' ? metadata.recallQuery : ''
}

export function runtimeStopReason(response: unknown): string | undefined {
  const value = typeof response === 'object' && response !== null && !Array.isArray(response)
    ? response as Record<string, unknown> : {}
  return value.stopReason === 'error' || value.stopReason === 'aborted'
    ? String(value.errorMessage ?? value.stopReason) : undefined
}
