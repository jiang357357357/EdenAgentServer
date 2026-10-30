import type { JsonValue } from '@eden/api'
import { qqIdentifierKind, qqTraceKeys } from '../../tool-results/index.ts'

const marker = '[宿主标识已隐藏]'
const object = (value: JsonValue) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Match old deletion identities only. This value must never be used as a model-history projection. */
export function legacyQqIdentity(message: JsonValue, receipts: JsonValue[]): JsonValue {
  const ids = new Set<string>()
  const collect = (value: JsonValue, segment?: string): void => {
    if (Array.isArray(value)) { value.forEach(item => collect(item, segment)); return }
    const fields = object(value)
    if (!fields) return
    const type = typeof fields.type === 'string' ? fields.type : segment
    for (const [key, item] of Object.entries(fields)) {
      if ((qqIdentifierKind(key, type) || qqTraceKeys.has(key)) && ['string', 'number'].includes(typeof item)) ids.add(String(item))
      else if (key !== 'parameters' && key !== 'model_view') collect(item, type)
    }
  }
  for (const receipt of receipts) {
    const fields = object(object(receipt)?.message ?? null)
    if (typeof fields?.toolName === 'string' && /^(?:eden_)?(?:list_qq_|read_qq_|execute_qq_|send_qq_)/.test(fields.toolName)) {
      collect(fields.details ?? null)
      if (Array.isArray(fields.content)) for (const block of fields.content) {
        const text = object(block)?.text
        if (typeof text === 'string') try { collect(JSON.parse(text) as JsonValue) } catch { /* Legacy plain text. */ }
      }
    }
  }
  const alternatives = [...ids].filter(id => id.length >= 8).sort((a, b) => b.length - a.length)
    .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!alternatives.length) return message
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${alternatives.join('|')})(?![A-Za-z0-9])`, 'g')
  const fields = object(message)
  if (!fields) return message
  const content = fields.content
  return { ...fields, ...(typeof content === 'string' ? { content: content.replace(pattern, marker) }
    : Array.isArray(content) ? { content: content.map(block => {
      const part = object(block)
      return part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: part.text.replace(pattern, marker) } : block
    }) } : {}) }
}
