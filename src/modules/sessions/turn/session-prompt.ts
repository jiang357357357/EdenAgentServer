import { replyLengthInstruction } from '../../../model-prompts/reply-length.ts'
import { modelParticipant } from '@eden/api'
import { modelEnvironmentContext } from '../../../model-prompts/environment.ts'
import type { JsonValue } from '@eden/api'
import { characterIdentity, characterContext, identityPrompt } from '../../../model-prompts/character-identity.ts'
import { promptModeContent } from '../../../model-prompts/prompt-mode.ts'
import { SESSION_SYSTEM_RULES, QQ_GROUP_RULES } from '../../../model-prompts/session.ts'
import { inputAttachments, modelAttachments } from '../../attachments/index.ts'

export function sessionPrompt(metadata: JsonValue): string { return sessionPromptContent(metadata).prompt }

const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

export function sessionPromptContent(metadata: JsonValue) {
  const source = object(metadata)
  const environmentSource = object(source.environment)
  const rawParticipants = Array.isArray(source.participants) ? source.participants : []
  const projected = rawParticipants.map(modelParticipant)
  const { sourceChannel: _environmentChannel, botQq: _botQq, contactQq: _contactQq, ...promptEnvironment } = environmentSource
  const context: Record<string, JsonValue> = { environment: promptEnvironment,
    participants: projected.length === 1 ? projected.map(characterContext) : projected,
    attachments: modelAttachments(inputAttachments(source)) }
  const job = object(source.job)
  if (typeof job.kind === 'string') context.task = { kind: job.kind }
  const preference = replyLengthInstruction(source, rawParticipants.length === 1 ? rawParticipants[0]! : null)
  const rules = [SESSION_SYSTEM_RULES, environmentSource.channelAudience === 'qq_group' ? QQ_GROUP_RULES : '', preference].filter(Boolean).join('\n')
  const { participants, environment: _environment, ...other } = context
  const environment = modelEnvironmentContext(context.environment)
  const identity = projected.length === 1 ? characterIdentity(projected[0]!) : ''
  const mode = promptModeContent(metadata)
  return { prompt: identityPrompt(identity, rules, { ...context, environment }) + mode.prompt, sources: [
    ...(identity ? [{ kind: 'character', title: '角色身份', content: identity }] : []),
    { kind: 'system', title: '系统规则', content: rules },
    ...mode.sources,
    { kind: 'character', title: '角色人设', content: participants ?? [] },
    { kind: 'environment', title: '环境信息', content: environment },
    { kind: 'environment', title: '会话与附件信息', content: other },
  ] }
}
