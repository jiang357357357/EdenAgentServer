import type { DirectorPlan, JsonValue } from '@eden/api'
import { ATTACHMENT_INPUT_CONTEXT_PREFIX } from './runtime-context.ts'

export { SESSION_SYSTEM_RULES as ACTOR_SYSTEM_RULES } from './session.ts'

const ACTOR_TURN_PREFIX = '你正在参与多人会话。正文直接开始说话，不用姓名报幕。自然承接前序公开回复。\n\n请参考以下导演计划和近期对话：\n\n'

export function actorTurnInstruction(userText: string, plan: DirectorPlan, beatIndex: number, conversation: JsonValue[]): string {
  return ACTOR_TURN_PREFIX + JSON.stringify({ userMessage: userText, scene: plan.scene, execution: plan.execution,
    beat: plan.beats[beatIndex], recentConversation: conversation })
}

/** Rewrite only our stored actor instruction; preserve its user text and director plan. */
export function projectActorTurnHistory(content: string, project: (history: JsonValue[]) => JsonValue[]): string {
  return projectActorTurnContent(content, value => ({ ...value, recentConversation: project(value.recentConversation as JsonValue[]) }))
}

/** The wrapper and director schema belong to the host; redact only the decoded payload. */
export function projectActorTurnContent(content: string, project: (value: Record<string, JsonValue>) => JsonValue): string {
  if (!content.startsWith(ACTOR_TURN_PREFIX)) return content
  const source = content.slice(ACTOR_TURN_PREFIX.length)
  // Host JSON escapes user newlines. Only the separately appended attachment
  // wrapper contains this literal separator outside that JSON value.
  const boundary = source.indexOf('\n\n' + ATTACHMENT_INPUT_CONTEXT_PREFIX)
  const json = boundary < 0 ? source : source.slice(0, boundary)
  const suffix = boundary < 0 ? '' : source.slice(boundary)
  const value = JSON.parse(json) as Record<string, JsonValue>
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.recentConversation)) {
    throw new Error('Stored actor instruction has invalid conversation history')
  }
  const next = project(value)
  return JSON.stringify(next) === JSON.stringify(value) ? content : ACTOR_TURN_PREFIX + JSON.stringify(next) + suffix
}
