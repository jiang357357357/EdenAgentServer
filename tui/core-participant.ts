function participantProfile(assistant: unknown): Record<string, unknown> {
  if (!assistant || typeof assistant !== 'object' || Array.isArray(assistant)) throw new Error('Core 助手资料格式无效')
  const value = assistant as Record<string, unknown>
  const id = Number(value.id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Core 助手 ID 无效')
  const character = value.character && typeof value.character === 'object' && !Array.isArray(value.character)
    ? value.character as Record<string, unknown> : {}
  return { assistantId: id, assistantName: String(value.name ?? character.name ?? `助手 ${id}`),
    characterId: character.id ?? null, characterName: String(character.name ?? ''),
    signature: String(character.signature ?? ''), position: 0, profile: value }
}

/** Load only the authenticated user's current assistant, preserving its Core profile for session creation. */
export async function currentParticipant(coreUrl: string, token?: string): Promise<Record<string, unknown>> {
  if (!token) throw new Error('Mon 世界尚未登录')
  const response = await fetch(new URL('/api/assistants/current/', coreUrl), {
    headers: { Authorization: `Token ${token}` }, signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`读取当前助手失败（HTTP ${response.status}）；请先在 Core 选择助手`)
  return participantProfile(await response.json())
}
