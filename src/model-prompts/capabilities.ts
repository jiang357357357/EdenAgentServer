export const CAPABILITY_DESCRIPTIONS = {
  list_tools: '按关键词分页发现当前角色可用的工具摘要，并查看已加载能力。返回稳定 id；load_tools 按 id 加载完整工具定义。',
  load_tools: '将已发现的工具加载到当前会话和行动角色，下一次模型请求即可使用。只需传入工具 id；每项独立返回加载结果。工具执行时按其权限流程处理。',
  unload_tools: '从当前角色的模型接口中卸载指定工具，基础工具继续保留。不会卸载技能说明或删除工具注册。',
  unload_skill: '停用当前角色的技能加载记录，不卸载关联工具，也不删除历史中的技能说明。',
} as const

export function capabilityHint(skills: readonly unknown[], stale: boolean): string {
  return '可用技能摘要：\n' + JSON.stringify(skills.slice(0, 96))
    + (skills.length === 0 ? '\n当前没有可供模型读取的技能条目；宿主使用指引仍然有效，已提供的工具仍可调用。不要使用旧目录中的技能名称。' : '')
    + (skills.length > 96 ? `\n当前共 ${skills.length} 个技能，摘要仅展示前 96 个；使用 list_skills 获取完整目录。` : '')
    + '\n此目录替代此前的技能目录。available=false 表示工具依赖不完整，仍可读取说明；不能因此调用缺失或被禁止的工具。摘要不是技能正文，不要凭摘要猜测操作步骤。技能正文已在当前上下文且版本适用时无需重复读取；正文缺失或版本变化时重新读取。'
    + '\n工具与技能独立：已知用法且工具接口可用时直接调用，无需每轮读取技能。需要流程指导时用 load_skill 读取说明；读取说明不改变工具接口；也可直接用 list_tools 和 load_tools 获取任意可用工具接口，包括技能提供的工具。unload_skill 不会卸载工具，释放工具接口用 unload_tools。'
    + (stale ? '\n部分加载记录已过期，可通过 list_tools 查看状态并重新加载。' : '')
}

export const MCP_IMAGE_REFERENCE = '[图片内容见图片块]'

export function toolDirectoryHint(tools: readonly { identity?: string; name: string; description: string }[]): string {
  return '可按需加载的工具目录（当前角色权限范围内，未加载完整接口）：\n'
    + JSON.stringify(tools.slice(0, 96).map(tool => ({ id: tool.identity ?? tool.name,
      description: tool.description.split(/[。\n]/u)[0]!.slice(0, 120) })))
    + (tools.length > 96 ? `\n另有 ${tools.length - 96} 项，可用 list_tools 按任务关键词检索。` : '')
    + '\n目录中的 id 可直接交给 load_tools，一次加载本任务相关工具；接口已提供时直接调用。无需先调用 list_tools，也无需为加载工具读取技能。'
    + '\n需要目录外能力时先按任务关键词搜索 list_tools；连接器和 MCP 是具体接入方式，不是每项任务的前置检查。MCP runtimeId 来自 list_mcp_servers 的真实结果。'
    + '\n目录表示存在工具入口，设备在线、插件已连接和操作成功仍以对应查询及执行结果为准。'
}
