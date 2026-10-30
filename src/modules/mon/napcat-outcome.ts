import type { JsonValue } from '@eden/api'
import type { ToolOutcome } from '@eden/runtime-pi'

/** NapCat's result contract is independent of HTTP success and bot selection. */
export function napcatOutcome(result: JsonValue): ToolOutcome {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown'
  if (result.status === 'success' || result.status === 'selection_required') return 'completed'
  if (result.status === 'failed' || result.status === 'not_configured') return 'failed'
  return 'unknown'
}
