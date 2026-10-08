import { rpcMethods, type JsonValue } from '@eden/api'

/** A bound channel cannot perform account-wide operations or target another session. */
export function assertSessionChannel(sessionId: string | undefined, method: string, params: JsonValue): void {
  if (!sessionId || method === 'ping') return
  const contract = Object.hasOwn(rpcMethods, method) ? rpcMethods[method as keyof typeof rpcMethods] : undefined
  const parsed = contract?.params.safeParse(params)
  const value = parsed?.success ? parsed.data : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('sessionId' in value) || value.sessionId !== sessionId)
    throw new Error('RPC must target the session bound to this connection')
  if (method.startsWith('agent.roles.import.')) throw new Error('Role imports require the control connection')
  const reading = ['skill.list', 'skill.read', 'skill.file', 'skill.catalog_status', 'agent.roles', 'agent.roles.edit'].includes(method)
  if (!reading && 'scope' in value && (value.scope === 'user' || value.scope === 'system'))
    throw new Error('Account-wide changes require the control connection')
}

export function priorityRequest(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || !('method' in raw)) return false
  return raw.method === 'turn.cancel' || raw.method === 'voice.tts.cancel' || raw.method === 'subagent.cancel'
}
