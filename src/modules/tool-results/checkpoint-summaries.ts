import type { RuntimeCheckpoint } from '@eden/api'

/** Old opaque summaries cannot prove which host fields they retained. Rebuild from the projected tree. */
export function checkpointSummaryBoundary(checkpoint: RuntimeCheckpoint, restoring: boolean): RuntimeCheckpoint {
  return { ...checkpoint, entries: checkpoint.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !['compaction', 'branch_summary'].includes(String(entry.type))) return entry
    if (!restoring || entry.modelResultBoundary === 1) return { ...entry, modelResultBoundary: 1 }
    return { type: 'custom', customType: 'eden.private_prior_summary', id: entry.id!, parentId: entry.parentId!,
      timestamp: entry.timestamp!, data: { original: entry, reason: 'model_result_boundary_rebuild' } }
  }) }
}
