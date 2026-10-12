import type { DirectorPlan, JsonValue } from '@eden/api'

export { SESSION_SYSTEM_RULES as ACTOR_SYSTEM_RULES } from './session.ts'

const ACTOR_TURN_PREFIX = '你正在参与多人会话。正文直接开始说话，不用姓名报幕。自然承接前序公开回复。\n\n请参考以下导演计划和近期对话：\n\n'

export function actorTurnInstruction(userText: string, plan: DirectorPlan, beatIndex: number, conversation: JsonValue[]): string {
  return ACTOR_TURN_PREFIX + JSON.stringify({ userMessage: userText, scene: plan.scene, execution: plan.execution,
    beat: plan.beats[beatIndex], recentConversation: conversation })
}

/** Rewrite only our stored actor instruction; preserve its user text and director plan. */
export function projectActorTurnHistory(content: string, project: (history: JsonValue[]) => JsonValue[]): string {
  if (!content.startsWith(ACTOR_TURN_PREFIX)) return content
  const value = JSON.parse(content.slice(ACTOR_TURN_PREFIX.length)) as Record<string, JsonValue>
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.recentConversation)) {
    throw new Error('Stored actor instruction has invalid conversation history')
  }
  const recentConversation = project(value.recentConversation)
  return JSON.stringify(recentConversation) === JSON.stringify(value.recentConversation)
    ? content : ACTOR_TURN_PREFIX + JSON.stringify({ ...value, recentConversation })
}
