import { replyLengthInstruction } from '../../../model-prompts/reply-length.ts'
import { modelParticipant } from '@eden/api'
import { modelEnvironmentContext } from '../../../model-prompts/environment.ts'
import type { JsonValue } from '@eden/api'
import { characterIdentity, characterContext, identityPrompt } from '../../../model-prompts/character-identity.ts'
import { promptModeContent } from '../../../model-prompts/prompt-mode.ts'
import { SESSION_SYSTEM_RULES, QQ_GROUP_RULES } from '../../../model-prompts/session.ts'
import { attachmentInputContext } from '../../../model-prompts/runtime-context.ts'
import { qqGroupTurnContext } from '../../../model-prompts/qq-group-context.ts'
import { inputAttachments, modelAttachments } from '../../attachments/index.ts'

export function sessionPrompt(metadata: JsonValue): string { return sessionPromptContent(metadata).prompt }

const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

export function sessionPromptContent(metadata: JsonValue, referenceTokenBudget?: number) {
  const source = object(metadata)
  const environmentSource = object(source.environment)
  const rawParticipants = Array.isArray(source.participants) ? source.participants : []
  const projected = rawParticipants.map(modelParticipant)
  const { sourceChannel: _environmentChannel, botQq: _botQq, contactQq: _contactQq, ...promptEnvironment } = environmentSource
  const participants = projected.length === 1 ? projected.map(characterContext) : projected
  const attachments = modelAttachments(inputAttachments(source))
  const context: Record<string, JsonValue> = { environment: modelEnvironmentContext(promptEnvironment) }
  const job = object(source.job)
  if (typeof job.kind === 'string') context.task = { kind: job.kind }
  const preference = replyLengthInstruction(source, rawParticipants.length === 1 ? rawParticipants[0]! : null)
  const rules = [SESSION_SYSTEM_RULES, environmentSource.channelAudience === 'qq_group' ? QQ_GROUP_RULES : '', preference].filter(Boolean).join('\n')
  const identity = projected.length === 1 ? characterIdentity(projected[0]!) : ''
  const mode = promptModeContent(metadata)
  const shared = object(source.channelContext).schema_version === 'qq-group-shared.v1'
  const privateQq = source.sourceChannel === 'qq' && environmentSource.channelAudience !== 'qq_group'
  const turnContext = shared || privateQq ? '' : qqGroupTurnContext(source, referenceTokenBudget)
  return { prompt: identityPrompt(identity, rules, { participants }, mode.leadingPrompt), runtimeContext: JSON.stringify(context),
    inputContext: attachmentInputContext(attachments), turnContext, trailingSystemPrompt: mode.trailingPrompt,
    systemPromptSuffix: mode.systemPromptSuffix, sources: [
    ...(identity ? [{ kind: 'character', title: '角色身份', content: identity }] : []),
    { kind: 'system', title: '系统规则', content: rules },
    { kind: 'character', title: '角色人设', content: participants ?? [] },
    { kind: 'environment', title: '环境信息', content: context.environment!, placement: 'runtime-context' },
    ...(context.task ? [{ kind: 'environment', title: '后台任务', content: context.task, placement: 'runtime-context' }] : []),
    { kind: 'environment', title: '本轮附件引用', content: attachments, placement: 'input' },
    ...(turnContext ? [{ kind: 'qq_group', title: '群聊公共上下文', content: turnContext, placement: 'turn-context' }] : []),
    ...mode.sources,
  ] }
}
