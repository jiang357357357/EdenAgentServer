import type { JsonValue } from '@eden/api'

export const SELF_AWAKE_DIARY_CLOCK = '用 write_diary 写日记。用 set_self_awake_timer 设置下次醒来的时间。'

export function selfAwakeInstruction(request: JsonValue): string {
  return `${SELF_AWAKE_DIARY_CLOCK}\n当前信息：\n${JSON.stringify(request)}`
}

export const SELF_AWAKE_INTERPRETATIONS = {
  diaries: '这是历史日记目录，供补充回忆；includeContent=true 配合 query 按具体主题检索原文，判断保留当时的时间与语境。',
  activity: '这是本次请求重新采集的状态；fresh=false 或 available=false 时当前状态未知，字段 null 不代表否。窗口在前台和输入空闲时长仅说明系统状态，用户是否在场、是否正在看界面仍未知。',
  notificationHistory: '这是历史通知记录，包含投递状态和人工处理标记。',
} as const

export const SELF_AWAKE_RECOVERY_INSTRUCTION = '这是失败后重新发起的一次自醒，请结合已有记录重新决定下一步。'
