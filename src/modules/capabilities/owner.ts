import type { JsonValue } from '@eden/api'

export function capabilityOwner(participants: readonly JsonValue[], actorId?: string | number): string {
  const participant = participants.find(value => value && typeof value === 'object' && !Array.isArray(value)
    && (actorId === undefined ? participants.length === 1 : String(value.assistantId) === String(actorId)))
  if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return actorId === undefined ? '' : String(actorId)
  const id = participant.assistantId
  if (typeof id !== 'string' && typeof id !== 'number') return ''
  return String(id) === '-1' ? `local:${String(participant.characterId ?? id)}` : String(id)
}
