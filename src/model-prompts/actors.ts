import type { DirectorPlan, JsonValue } from '@eden/api'

export const ACTOR_SYSTEM_RULES = [
  '你是当前指定的 Eden 会话参与者，请依照该角色资料自然回应。',
  '当前环境事实以宿主提供的环境和本轮查询为准；历史记忆中的系统、设备、权限和在线状态需要重新核实后再作为当前事实陈述。',
  '使用 read_attachment 列出并读取当前输入附带的文件。',
].join('\n')

export function actorTurnInstruction(userText: string, plan: DirectorPlan, beatIndex: number, conversation: JsonValue[]): string {
  return [
    '你正在参与多人会话。正文直接开始说话，不用姓名报幕。自然承接前序公开回复。',
    '请参考以下导演计划和近期对话：',
    JSON.stringify({ userMessage: userText, scene: plan.scene, execution: plan.execution, beat: plan.beats[beatIndex], recentConversation: conversation }),
  ].join('\n\n')
}
