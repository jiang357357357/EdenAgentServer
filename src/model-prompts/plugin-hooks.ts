export function pluginHookInstruction(input: { pluginId: string; revision: string; hookId: string; eventId: string; event: string; occurredAt: number; skillName: string; skillContent: string }): string {
  return `插件声明式钩子触发。来源插件：${input.pluginId}，版本：${input.revision}，钩子：${input.hookId}。
事件：${JSON.stringify({ id: input.eventId, kind: input.event, occurredAt: input.occurredAt })}
本钩子绑定技能 ${input.skillName}，请按下方技能说明处理事件。
技能说明（超过 32000 字符截断）：
${input.skillContent.slice(0, 32000)}`
}
