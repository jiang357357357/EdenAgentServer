import { modelEnvironment, modelParticipant } from '@eden/api'
import type { DirectorPlan, JsonValue } from '@eden/api'
import { inputAttachments } from '../attachments/index.ts'
import { ACTOR_SYSTEM_RULES, actorTurnInstruction } from '../../model-prompts/actors.ts'

export function actorSystemPrompt(participant: JsonValue, metadata?: JsonValue): string { return actorSystemContent(participant, metadata).prompt }

export function actorSystemContent(rawParticipant: JsonValue, metadata?: JsonValue) {
  const participant = modelParticipant(rawParticipant)
  const snapshot = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const rules = ACTOR_SYSTEM_RULES
  const environment = modelEnvironment(snapshot.environment), attachments = inputAttachments(metadata)
  return { prompt: `${rules}\n${JSON.stringify({ participant, environment, attachments })}`, sources: [
    { kind: 'system', title: '系统规则', content: rules },
    { kind: 'character', title: '角色人设', content: participant },
    { kind: 'environment', title: '环境信息', content: environment },
    { kind: 'environment', title: '附件引用', content: attachments },
  ] }
}

export function actorPrompt(userText: string, plan: DirectorPlan, beatIndex: number, conversation: JsonValue[]): string {
  return actorTurnInstruction(userText, plan, beatIndex, conversation)
}
