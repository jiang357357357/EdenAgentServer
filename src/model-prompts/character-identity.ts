import type { JsonValue } from '@eden/api'

/** Use the selected character's own identity text; host rules describe operating conditions. */
export function characterIdentity(participant: JsonValue): string {
  const value = object(participant), profile = object(value.profile)
  const character = object(profile.character ?? value.character)
  const prompt = character.system_prompt ?? character.systemPrompt ?? profile.system_prompt ?? profile.systemPrompt
  if (typeof prompt === 'string' && prompt.trim()) return prompt.trim()
  const name = character.name ?? value.characterName ?? profile.name ?? value.assistantName
  return typeof name === 'string' && name.trim() ? `你是${name.trim()}。` : ''
}

export function identityPrompt(identity: string, rules: string, context: JsonValue): string {
  return `${identity ? identity + '\n\n' : ''}${rules}\n${JSON.stringify(context)}`
}
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
