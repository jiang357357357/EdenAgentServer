import type { JsonValue } from '@eden/api'
import { toJson } from '@eden/api'
import { inputAttachments } from './input.ts'
import { modelAttachments } from './model-attachments.ts'
import { attachmentInputContext } from '../../model-prompts/runtime-context.ts'

/** Replace the current user's inline image blocks with immutable attachment references. */
export function attachmentMessage(payload: Record<string, JsonValue>, metadata?: JsonValue): Record<string, JsonValue> {
  const message = payload.message
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== 'user') return payload
  const attachments = inputAttachments(metadata)
  if (!attachments.length) return payload
  const original = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []
  const suffix = '\n\n' + attachmentInputContext(modelAttachments(attachments))
  const content = original.filter(block => !block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'image')
    .map(block => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text'
      && typeof block.text === 'string' && block.text.endsWith(suffix)
      ? { ...block, text: block.text.slice(0, -suffix.length) } : block)
  return { ...payload, message: { ...message, content: [...content, ...attachments.map(attachment => toJson({ type: 'attachment', ...attachment }))] } }
}
