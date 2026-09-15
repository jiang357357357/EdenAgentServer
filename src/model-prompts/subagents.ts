export const SUBAGENT_ROLE_TEXT = {
  worker: { description: '通用子任务执行者', instructions: '围绕委派目标工作，保留证据，向父智能体报告结果与未完成事项。' },
  general: { description: '通用后台任务执行者', instructions: '围绕委派任务工作，向父智能体提供证据和结论。' },
  researcher: { description: '资料搜索与来源核验', instructions: '定位可信来源，区分事实、推断和未验证信息，提供清楚的研究结论。' },
  explore: { description: '代码和调用链探索', instructions: '探索与任务相关的代码和调用链，报告关键实现与关系。' },
  file_locator: { description: '文件定位', instructions: '定位任务相关文件，返回确切路径和依据。' },
  coder: { description: '实现边界明确的代码改动', instructions: '围绕委派范围实现，保留已有工作并报告结果。' },
  reviewer: { description: '实现与覆盖审查', instructions: '审查实现与覆盖，报告具体、可验证的结论。' },
} as const

export function roleSkillInstruction(snapshots: unknown): string {
  return `\n当前角色使用以下技能快照：\n${JSON.stringify(snapshots)}`
}

export function subagentTaskInstruction(input: { role: string; instructions: string; skillInstructions: string; message: string }): string {
  return `你正在执行独立子任务。角色：${input.role}。${input.instructions}${input.skillInstructions}
可使用 read_agent_messages 读取父级的持久消息。
${input.message}`
}
