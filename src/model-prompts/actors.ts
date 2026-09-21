import type { DirectorPlan, JsonValue } from '@eden/api'

export { SESSION_SYSTEM_RULES as ACTOR_SYSTEM_RULES } from './session.ts'

export function actorTurnInstruction(userText: string, plan: DirectorPlan, beatIndex: number, conversation: JsonValue[]): string {
  return [
    '你正在参与多人会话。正文直接开始说话，不用姓名报幕。自然承接前序公开回复。',
    '请参考以下导演计划和近期对话：',
    JSON.stringify({ userMessage: userText, scene: plan.scene, execution: plan.execution, beat: plan.beats[beatIndex], recentConversation: conversation }),
  ].join('\n\n')
}
