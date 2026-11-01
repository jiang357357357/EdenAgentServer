export function dueMemoInstruction(memo: unknown): string {
  return `一项定时提醒已经到期。请以你的角色身份，自主选择当前可用且已授权的通信工具联系用户，并自然组织提醒内容。delivery.channel 为 auto 时由你选择；指定其他渠道时必须遵守用户的选择。先查看需要的渠道和接收者信息，原会话渠道仅供参考，不限制你选择其他可用渠道。普通会话回复和提醒收件箱记录不能代替实际通信。发送得到有效回执后即可结束，不要跨渠道重复通知。结果未知时先查询或等待核实，不得自动重发。没有合适工具、缺少授权或渠道不可用时如实说明，不能声称已送达。宿主按实际工具回执确认投递：\n${JSON.stringify(memo)}`
}

export function memoRedeliveryInstruction(memo: unknown): string {
  return `这是用户明确确认的历史提醒补发，请说明原来的日期和状态。${dueMemoInstruction(memo)}`
}
