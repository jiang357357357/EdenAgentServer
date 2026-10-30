import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import { validCheckpointImage } from '@eden/runtime-pi'

const object = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const mcpTool = (name: unknown) => typeof name === 'string'
  && (name.startsWith('mcp__') || ['call_mcp_tool', 'read_mcp_resource'].includes(name.replace(/^eden_/, '')))

function receiptImages(value: JsonValue | undefined): JsonValue[] {
  const raw = object(value)
  const content = raw?.content ?? raw?.contents
  if (!Array.isArray(content)) return []
  const candidates = content.flatMap(item => {
    const block = object(item), resource = object(block?.resource) ?? block
    if (!resource || typeof resource.mimeType !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(resource.mimeType)) return []
    const image = { type: 'image', mimeType: resource.mimeType, data: resource.data ?? resource.blob ?? null }
    return [image]
  })
  return candidates.every(validCheckpointImage) ? candidates : []
}

/** Recover only from a unique same-call, same-tool audit receipt, never by guessing replaced characters. */
export function recoverCheckpointMedia(checkpoint: RuntimeCheckpoint, receipts: JsonValue[]): RuntimeCheckpoint {
  if (!receipts.length) return checkpoint
  const originals = new Map<string, JsonValue[] | null>()
  const key = (message: Record<string, JsonValue>) => JSON.stringify([message.toolName, message.toolCallId])
  for (const receipt of receipts) {
    const message = object(object(receipt)?.message)
    if (!message || !mcpTool(message.toolName) || typeof message.toolCallId !== 'string') continue
    const id = key(message)
    originals.set(id, originals.has(id) ? null : receiptImages(message.details))
  }
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit)
    const fields = object(value)
    if (!fields) return value
    let next = fields
    if (fields.role === 'toolResult' && mcpTool(fields.toolName) && Array.isArray(fields.content)) {
      const images = fields.content.filter(item => object(item)?.type === 'image')
      const source = originals.get(key(fields))
      if (source?.length === images.length && images.length) {
        let at = 0
        next = { ...next, content: fields.content.map(block => {
          if (object(block)?.type !== 'image') return block
          const original = source[at++]!
          return validCheckpointImage(block) || object(block)?.mimeType !== object(original)?.mimeType ? block : original
        }) }
      }
    }
    for (const field of ['message', 'retainedTail']) if (fields[field]) next = { ...next, [field]: visit(fields[field]!) }
    return next
  }
  return { ...checkpoint, entries: checkpoint.entries.map(visit) }
}
