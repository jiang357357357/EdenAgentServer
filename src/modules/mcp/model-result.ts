import { MCP_IMAGE_REFERENCE } from '../../model-prompts/capabilities.ts'
import type { JsonValue } from '@eden/api'

/** Keep the durable result intact; binary image bytes travel only in image blocks. */
export function mcpModelResult(result: JsonValue): JsonValue {
  if (Array.isArray(result)) return result.map(mcpModelResult)
  if (!result || typeof result !== 'object') return result
  const image = typeof result.mimeType === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(result.mimeType)
  return Object.fromEntries(Object.entries(result).map(([key, value]) =>
    [key, image && (key === 'data' || key === 'blob') ? MCP_IMAGE_REFERENCE : mcpModelResult(value)]))
}
