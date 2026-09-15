export function dueMemoInstruction(memo: { title: string; content: string }): string {
  return `一项定时提醒已经到期，请根据以下内容自然地通知用户：\n${JSON.stringify(memo)}`
}

export function memoRedeliveryInstruction(memo: unknown): string {
  return `请重新投递以下历史提醒，并清楚说明它原来的日期和状态：\n${JSON.stringify(memo)}`
}
