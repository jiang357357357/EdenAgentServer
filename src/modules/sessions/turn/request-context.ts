import { createHash } from 'node:crypto'
import type { JsonValue } from '@eden/api'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')

/** Text/JSON heuristic only: image tokens and provider framing are not locally measurable. */
export function estimateRequestTokens(value: unknown): number {
  if (Array.isArray(value) && value.length === 0) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => key === 'image_url' ? '[image omitted]' : item) ?? ''
  const wide = [...text].filter(char => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(char)).length
  return wide + Math.ceil((text.length - wide) / 4)
}

export function requestContext(snapshot: unknown, metadata: unknown, previous: unknown, assistantID?: string | number): Record<string, JsonValue> {
  const request = object(snapshot), payload = object(request.payload), prior = object(previous)
  const messages = Array.isArray(payload.messages) ? payload.messages.map(object) : []
  const prefix = messages.filter(message => message.role === 'system' || message.role === 'developer')
  const categories = promptCategories(prefix, request, metadata, assistantID)
  const identity = { provider: request.provider ?? null, model: request.model ?? null, reasoning: payload.reasoning_effort ?? null, system: prefix, tools: payload.tools ?? [] }
  const fingerprint = hash(identity)
  const stable = prior.promptCacheFingerprint === fingerprint
  const epoch = typeof prior.promptCacheEpoch === 'number' ? prior.promptCacheEpoch : 0
  return { ...categories, tools: estimateRequestTokens(payload.tools ?? []),
    history: estimateRequestTokens(messages.filter(message => message.role !== 'system' && message.role !== 'developer')),
    tokenizer: 'text-json-heuristic', promptCacheFingerprint: fingerprint,
    promptCacheEpoch: stable ? epoch : epoch + 1,
    promptCacheInvalidationReason: stable ? 'stable' : epoch ? 'fingerprint' : 'initial' }
}

function promptCategories(prefix: Record<string, unknown>[], request: Record<string, unknown>, metadata: unknown, assistantID?: string | number) {
  let systemText = prefix.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  let skills = 0, character = 0
  const hints = Array.isArray(request.promptHints) ? request.promptHints.map(object) : []
  for (const hint of hints) {
    if (hint.name !== 'list_skills' || typeof hint.text !== 'string' || !systemText.includes(hint.text)) continue
    skills += estimateRequestTokens(hint.text)
    systemText = systemText.replace(hint.text, '')
  }
  const participants = object(metadata).participants
  for (const participant of Array.isArray(participants) ? participants : []) {
    if (assistantID !== undefined && String(object(participant).assistantId) !== String(assistantID)) continue
    const text = JSON.stringify(participant)
    if (!systemText.includes(text)) continue
    character += estimateRequestTokens(text)
    systemText = systemText.replace(text, '')
  }
  return { character, skills, system: estimateRequestTokens(systemText) }
}
