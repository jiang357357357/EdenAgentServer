export const CAPABILITY_DESCRIPTIONS = {
  list_tools: '按关键词分页查看当前角色的工具摘要和 id。loaded 只表示参数说明是否展开，不代表执行权限。',
  load_tools: '按工具 id 展开完整参数说明，从下一次请求生效。已知名称和参数可直接调用，权限仍由宿主判断。',
  unload_tools: '收起指定工具的参数说明，基础工具继续展示。不改动工具注册和权限。',
  unload_skill: '停用当前角色的技能加载记录，不卸载关联工具，也不删除历史中的技能说明。',
} as const

export const SKILL_DISCOVERY_INSTRUCTION = '技能目录见有来源的运行资料快照；摘要用于发现，操作步骤需读取完整技能说明。available=false 仅表示工具依赖不完整。'
export const TOOL_DISCOVERY_INSTRUCTION = '工具摘要见运行资料快照，可能只展示部分条目。知道名称和参数可直接调用；需要参数用 load_tools，不确定有哪些工具用 list_tools，需要操作步骤用 load_skill。参数是否展开、当前页是否列出均不代表执行权限；权限由宿主判断。'

export function capabilityHint(skills: readonly unknown[], stale: boolean): string {
  return '可用技能摘要：\n' + JSON.stringify(skills.slice(0, 96))
    + (skills.length === 0 ? '\n当前没有可供模型读取的技能条目；当前授权范围内已注册的工具仍可调用。' : '')
    + (skills.length > 96 ? `\n当前共 ${skills.length} 个技能，摘要仅展示前 96 个；使用 list_skills 获取完整目录。` : '')
    + (stale ? '\n部分说明展示记录已过期，可通过 list_tools 查看当前定义并按需加载说明。' : '')
}

export const MCP_IMAGE_REFERENCE = '[图片内容见图片块]'
export const EMPTY_CONNECTOR_NOTICE = '当前会话没有绑定自定义连接器。此列表不包含 QQ 等内置能力；需要发送 QQ 文件时，查询或调用 send_qq_file，并以渠道状态、授权和真实回执判断是否可发送。'

export function toolDirectoryHint(tools: readonly { identity?: string; name: string; description: string }[]): string {
  const ordered = tools.toSorted((left, right) => {
    const a = left.identity ?? left.name, b = right.identity ?? right.name
    return a < b ? -1 : a > b ? 1 : 0
  })
  return '当前已注册的可用工具目录（摘要不表示参数展开状态）：\n'
    + JSON.stringify(ordered.slice(0, 96).map(tool => ({ id: tool.identity ?? tool.name, name: tool.name,
      description: tool.description.split(/[。\n]/u)[0]!.slice(0, 120) })))
    + (tools.length > 96 ? `\n另有 ${tools.length - 96} 项，可用 list_tools 按任务关键词检索。` : '')
}
