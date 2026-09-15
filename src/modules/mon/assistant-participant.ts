import { toJson, modelCharacterProfile } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { parseCoreAssistant } from './model-schema.ts'

export function assistantParticipant(detail: unknown): JsonValue {
  const assistant = parseCoreAssistant(detail)
  const character = assistant.character
  const text = (key: string) => typeof character[key] === 'string' ? character[key] : ''
  const identifier = (key: string) => typeof character[key] === 'string' || typeof character[key] === 'number' ? character[key] : null
  const profile = { id: assistant.id, name: assistant.name, character: {
    id: character.id, name: character.name,
    ...(modelCharacterProfile(character) as Record<string, JsonValue>),
  } }
  const participant = toJson({ assistantId: assistant.id, assistantName: assistant.name || character.name,
    characterId: character.id, characterName: character.name, signature: text('signature'), avatarUrl: text('avatar_url'),
    standingImageUrl: text('default_standing_image_url'), ttsConfigId: identifier('tts_config_id'), sttConfigId: identifier('stt_config_id'), position: 0, profile })
  if (Buffer.byteLength(JSON.stringify(participant)) > 65536) throw new Error('Assistant profile exceeds the handoff size limit')
  return participant
}
