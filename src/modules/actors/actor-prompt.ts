import { replyLengthInstruction } from '../../model-prompts/reply-length.ts'
import { modelParticipant, toJson } from '@eden/api'
import { modelEnvironmentContext } from '../../model-prompts/environment.ts'
import type { DirectorPlan, JsonValue } from '@eden/api'
import { inputAttachments, modelAttachments } from '../attachments/index.ts'
import { characterIdentity, characterContext, identityPrompt } from '../../model-prompts/character-identity.ts'
import { promptModeContent } from '../../model-prompts/prompt-mode.ts'
import { ACTOR_SYSTEM_RULES, actorTurnInstruction } from '../../model-prompts/actors.ts'
import { attachmentInputContext } from '../../model-prompts/runtime-context.ts'

export function actorSystemPrompt(participant: JsonValue, metadata?: JsonValue): string { return actorSystemContent(participant, metadata).prompt }

export function actorSystemContent(rawParticipant: JsonValue, metadata?: JsonValue) {
  const projected = modelParticipant(rawParticipant), participant = characterContext(projected)
  const snapshot = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const rules = [ACTOR_SYSTEM_RULES, replyLengthInstruction(snapshot, rawParticipant)].filter(Boolean).join('\n')
  const environment = modelEnvironmentContext(snapshot.environment), attachments = modelAttachments(inputAttachments(metadata))
  const identity = characterIdentity(projected), mode = promptModeContent(metadata)
  return { prompt: identityPrompt(identity, rules, toJson({ participant }), mode.leadingPrompt), runtimeContext: JSON.stringify({ environment }),
    inputContext: attachmentInputContext(attachments), trailingSystemPrompt: mode.trailingPrompt,
    systemPromptSuffix: mode.systemPromptSuffix, sources: [
    ...(identity ? [{ kind: 'character', title: '角色身份', content: identity }] : []),
    { kind: 'system', title: '系统规则', content: rules },
    { kind: 'character', title: '角色人设', content: participant },
    { kind: 'environment', title: '环境信息', content: environment, placement: 'runtime-context' },
    { kind: 'environment', title: '本轮附件引用', content: attachments, placement: 'input' },
    ...mode.sources,
  ] }
}

export function actorPrompt(userText: string, plan: DirectorPlan, beatIndex: number, conversation: JsonValue[]): string {
  return actorTurnInstruction(userText, plan, beatIndex, conversation)
}
