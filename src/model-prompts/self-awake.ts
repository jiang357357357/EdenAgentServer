import type { JsonValue } from '@eden/api'

export const SELF_AWAKE_DIARY_CLOCK = '用 write_diary 写日记。以当前角色的口吻，围绕 recent_conversation 中近期真实交流和确有依据的经历，写下此刻的感受、想法和在意的事情；没有新交流时可以简短记录，不编造对话或行动。日记不是工作日志，无需逐项汇报任务进度、工具调用或系统状态；即使谈到工作，也写自己的体会。默认不必查阅过去的日记，需要回忆具体往事时再按主题检索；旧日记里的判断和打算不构成本轮任务，不据此自行延续排障。set_self_awake_timer 设置当前账号、当前角色唯一的下次自醒时间，再次设置会替换同一角色的旧时间；普通会话不各自续约。兜底只在没有有效角色计划时补漏。用户明确指定的到期事项使用备忘提醒，不为每项另建自醒循环。'

export function selfAwakeInstruction(request: JsonValue): string {
  return `${SELF_AWAKE_CONTACT}\n${SELF_AWAKE_DIARY_CLOCK}\n当前信息：\n${JSON.stringify(request)}`
}

export const SELF_AWAKE_CONTACT = '这是你自己醒来的一段时间。先看看 recent_conversation 中近期真实交流，再决定此刻有没有想对老师说的话。可以接续共同话题、问一句惦记的事、分享想法或自然打招呼，不需要等到有工作任务、故障或紧急事项才开口。主动联系通过已配置且可用的 QQ、邮件或在线设备进行，遵循用户的渠道与时段偏好；当前 App 不作为主动聊天渠道，不向 App 会话主动追加消息。发送前核对渠道状态和近期往来，一次选择一个渠道；同一话题近期已联系且没有新回复时留出空间。也可以安静写日记，不必每轮都发消息。日记是写给自己的，想让老师收到的话需要调用相应渠道的发送工具；写在日记或本轮最终回答里不代表已经联系。accepted 不证明用户已读，失败或未知不能写成已送达。最后写日记并安排下次自醒。'

// Historical template matching only; never used to construct a new instruction.
const SELF_AWAKE_HISTORY_START = '用 write_diary 写日记。'
const SELF_AWAKE_CONTACT_HISTORY_START = '这是你自己醒来的一段时间。'

/** Match the host wrapper, including older clock wording; arbitrary user JSON stays opaque. */
export function projectSelfAwakeHistory(content: string, project: (value: JsonValue) => JsonValue): string {
  const marker = '\n当前信息：\n', boundary = content.indexOf(marker)
  if ((!content.startsWith(SELF_AWAKE_HISTORY_START) && !content.startsWith(SELF_AWAKE_CONTACT_HISTORY_START)) || boundary < 0) return content
  return selfAwakeInstruction(project(JSON.parse(content.slice(boundary + marker.length)) as JsonValue))
}

export const SELF_AWAKE_INTERPRETATIONS = {
  diaries: '这是历史日记目录，仅供按需回忆，不是本轮任务或日记写作模板；本轮写作优先参考近期真实会话。includeContent=true 配合 query 按具体主题检索原文，判断保留当时的时间与语境。',
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
