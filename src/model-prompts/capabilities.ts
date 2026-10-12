export const CAPABILITY_DESCRIPTIONS = {
  list_tools: '按关键词分页发现当前角色可用的工具摘要，并查看已加载能力。返回稳定 id；load_tools 按 id 加载完整工具定义。',
  load_tools: '按工具 id 为当前会话和行动角色加载完整接口；下一次模型请求可用，每项独立返回结果。',
  unload_tools: '从当前角色的模型接口中卸载指定工具，基础工具继续保留。不会卸载技能说明或删除工具注册。',
  unload_skill: '停用当前角色的技能加载记录，不卸载关联工具，也不删除历史中的技能说明。',
} as const

export function capabilityHint(skills: readonly unknown[], stale: boolean): string {
  return '可用技能摘要：\n' + JSON.stringify(skills.slice(0, 96))
    + (skills.length === 0 ? '\n当前没有可供模型读取的技能条目；已加载工具仍可调用。' : '')
    + (skills.length > 96 ? `\n当前共 ${skills.length} 个技能，摘要仅展示前 96 个；使用 list_skills 获取完整目录。` : '')
    + '\navailable=false 表示工具依赖不完整，技能说明仍可读取。摘要用于发现，操作步骤见完整说明。'
    + (stale ? '\n部分加载记录已过期，可通过 list_tools 查看状态并重新加载。' : '')
}

export const MCP_IMAGE_REFERENCE = '[图片内容见图片块]'

export function toolDirectoryHint(tools: readonly { identity?: string; name: string; description: string }[]): string {
  return '可按需加载的工具目录（尚未加载完整接口）：\n'
    + JSON.stringify(tools.slice(0, 96).map(tool => ({ id: tool.identity ?? tool.name,
      description: tool.description.split(/[。\n]/u)[0]!.slice(0, 120) })))
    + (tools.length > 96 ? `\n另有 ${tools.length - 96} 项，可用 list_tools 按任务关键词检索。` : '')
    + '\n已加载工具直接调用；未加载工具将目录 id 交给 load_tools，目录外能力用 list_tools 按关键词检索。需要流程说明时用 load_skill；读取说明不加载工具，已有适用说明无需重复读取。'
    + '\n目录只列工具入口，实际可用状态以查询和执行结果为准。'
}
