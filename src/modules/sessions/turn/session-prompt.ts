import { modelEnvironment, modelParticipant } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { SESSION_SYSTEM_RULES } from '../../../model-prompts/session.ts'

export function sessionPrompt(metadata: JsonValue): string { return sessionPromptContent(metadata).prompt }

export function sessionPromptContent(metadata: JsonValue) {
  const raw = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const context: Record<string, JsonValue> = { ...raw, participants: Array.isArray(raw.participants) ? raw.participants.map(modelParticipant) : [] }
  const rules = SESSION_SYSTEM_RULES
  const { participants, environment: _environment, ...other } = context
  const environment = modelEnvironment(context.environment)
  return { prompt: rules + '\n' + JSON.stringify({ ...context, environment }), sources: [
    { kind: 'system', title: '系统规则', content: rules },
    { kind: 'character', title: '角色人设', content: participants ?? [] },
    { kind: 'environment', title: '环境信息', content: environment },
    { kind: 'environment', title: '会话与附件信息', content: other },
  ] }
}
