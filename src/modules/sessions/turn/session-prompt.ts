import { replyLengthInstruction } from '../../../model-prompts/reply-length.ts'
import { modelEnvironment, modelParticipant } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { characterIdentity, identityPrompt } from '../../../model-prompts/character-identity.ts'
import { SESSION_SYSTEM_RULES } from '../../../model-prompts/session.ts'
import { QQ_CHANNEL_RULES } from '../../../model-prompts/qq-channel.ts'

export function sessionPrompt(metadata: JsonValue): string { return sessionPromptContent(metadata).prompt }

export function sessionPromptContent(metadata: JsonValue) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const { recallQuery: _recallQuery, replyLengths: _replyLengths, ...raw } = source
  const context: Record<string, JsonValue> = { ...raw, participants: Array.isArray(raw.participants) ? raw.participants.map(modelParticipant) : [] }
  const preference = replyLengthInstruction(source, Array.isArray(raw.participants) && raw.participants.length === 1 ? raw.participants[0]! : null)
  const rules = [SESSION_SYSTEM_RULES, source.sourceChannel === 'qq' ? QQ_CHANNEL_RULES : '', preference].filter(Boolean).join('\n')
  const { participants, environment: _environment, ...other } = context
  const environment = modelEnvironment(context.environment)
  const identity = Array.isArray(participants) && participants.length === 1 ? characterIdentity(participants[0]!) : ''
  return { prompt: identityPrompt(identity, rules, { ...context, environment }), sources: [
    ...(identity ? [{ kind: 'character', title: '角色身份', content: identity }] : []),
    { kind: 'system', title: '系统规则', content: rules },
    { kind: 'character', title: '角色人设', content: participants ?? [] },
    { kind: 'environment', title: '环境信息', content: environment },
    { kind: 'environment', title: '会话与附件信息', content: other },
  ] }
}
