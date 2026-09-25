import type { JsonValue } from '@eden/api'

const object = (value: JsonValue | undefined): Record<string, JsonValue> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
export function replyLengthInstruction(metadata: JsonValue, participant: JsonValue): string {
  const source = object(metadata), actor = object(participant)
  if (source.job || object(source.environment).sessionPurpose === 'self_awake') return ''
  const length = object(source.replyLengths)[String(actor.characterId ?? actor.characterID ?? '')]
  const preference = length === 'short' ? '简短回答，通常一两段' : length === 'long' ? '详细展开，按需补充解释与例子' : length === 'medium' ? '自然展开，说明必要内容' : ''
  return preference ? `聊天回复长度偏好：${preference}，保持回答完整；本轮用户明确要求的长度优先。` : ''
}
