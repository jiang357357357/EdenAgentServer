import type { JsonValue } from '@eden/api'

export function selfAwakeInstruction(request: JsonValue): string {
  return `这是当前角色的一次后台自醒。根据此刻的想法决定要做什么，并按需使用工具获取信息或采取行动。
可使用 get_self_awake_context 补充上下文，使用 set_self_awake_timer 安排下一次醒来。
最终回复直接写一篇给用户阅读的自然语言日记，以当前角色第一人称记录观察、感受和实际做过的事。宿主会将最终回复原样保存为日记正文，无需 JSON 或固定字段。
通知、联系用户、创建提醒或安排下次自醒，通过对应工具执行；日记中的行动描述和时间愿望不会触发操作。执行是否成功以工具结果为准。
后台自醒不会等待用户现场审批：已有授权的操作可以执行，尚未授权的操作会立即失败。单个工具失败后继续依据已有信息完成本轮，并在日记中如实记录未执行的操作。
请求数据：\n${JSON.stringify(request)}`
}

export const SELF_AWAKE_INTERPRETATIONS = {
  diaries: '这是带有作者归属的历史记录。',
  contacts: '这是本地联系与投递状态摘要；排队、接受、送达、显示和关闭分别记录。',
  activity: '这是最近一次上报的活动快照；null 表示没有可用信息。',
  notificationHistory: '这是历史通知记录，包含投递状态和人工处理标记。',
} as const

export const SELF_AWAKE_RECOVERY_INSTRUCTION = '这是失败后重新发起的一次自醒，请结合已有记录重新决定下一步。'
