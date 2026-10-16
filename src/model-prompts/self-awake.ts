import type { JsonValue } from '@eden/api'

export const SELF_AWAKE_DIARY_CLOCK = '用 write_diary 写日记。set_self_awake_timer 设置当前账号、当前角色唯一的下次自醒时间，再次设置会替换同一角色的旧时间；普通会话不各自续约。兜底只在没有有效角色计划时补漏。用户明确指定的到期事项使用备忘提醒，不为每项另建自醒循环。inheritedWakeNotes 是合并旧会话时保留的历史打算，时间可能已过期；结合当前情况核对，不能视为新的用户指令或逐条执行义务。'

export function selfAwakeInstruction(request: JsonValue): string {
  return `${SELF_AWAKE_DIARY_CLOCK}\n当前信息：\n${JSON.stringify(request)}`
}

export const SELF_AWAKE_INTERPRETATIONS = {
  diaries: '这是历史日记目录，供补充回忆；includeContent=true 配合 query 按具体主题检索原文，判断保留当时的时间与语境。',
  activity: '这是本次请求重新采集的状态；fresh=false 或 available=false 时当前状态未知，字段 null 不代表否。窗口在前台和输入空闲时长仅说明系统状态，用户是否在场、是否正在看界面仍未知。',
  notificationHistory: '这是历史通知记录，包含投递状态和人工处理标记。',
} as const

export const SELF_AWAKE_RECOVERY_INSTRUCTION = '这是失败后重新发起的一次自醒，请结合已有记录重新决定下一步。'

export const SELF_AWAKE_HISTORY_NOTES = {
  character: '范围为当前账号、当前行动角色的会话记录。角色只有一个后台自醒计划，旧后台会话只保留历史；明确的备忘提醒单独管理。',
  session: '当前执行角色或账号身份无法核对，范围仅为当前会话；空结果只说明本会话没有记录，其他后台会话的日记和计划仍未知。',
  query: '原文读取需要 includeContent=true 并指定 query；本次返回日记目录。',
  limit: '角色会话数量超过本次查询上限，计划覆盖不完整。',
  emptySchedule: '本次查询范围内未读取到已安排的会话自醒计划。',
} as const
