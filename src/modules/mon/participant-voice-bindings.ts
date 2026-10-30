import type { JsonValue } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'

export interface ParticipantVoiceBinding {
  assistantId: string | number
  ttsConfigId?: number | null | undefined
  sttConfigId?: number | null | undefined
}

/** Refresh service bindings without replacing the conversation's character snapshot. */
export function refreshParticipantVoiceBindings(sessions: SessionRepository, sessionId: string, bindings: ParticipantVoiceBinding[]) {
  const current = sessions.read(sessionId).participants
  let changed = false
  const participants = current.map(participant => {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return participant
    const binding = bindings.find(value => String(value.assistantId) === String(participant.assistantId))
    if (!binding) return participant
    const next: Record<string, JsonValue> = { ...participant }
    for (const key of ['ttsConfigId', 'sttConfigId'] as const) {
      if (binding[key] === undefined || participant[key] === binding[key]) continue
      next[key] = binding[key]
      changed = true
    }
    return next
  })
  if (changed) sessions.setMetadata(sessionId, participants)
}
