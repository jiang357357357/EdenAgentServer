export const CAPABILITY_DESCRIPTIONS = {
  list_tools: '按关键词分页查看当前角色的工具摘要和 id。loaded 只表示参数说明是否展开，不代表执行权限。',
  load_tools: '按工具 id 展开完整参数说明，从下一次请求生效。已知名称和参数可直接调用，权限仍由宿主判断。',
  unload_tools: '收起指定工具的参数说明，基础工具继续展示。不改动工具注册和权限。',
  unload_skill: '停用当前角色的技能加载记录，不卸载关联工具，也不删除历史中的技能说明。',
} as const

export function capabilityHint(skills: readonly unknown[], stale: boolean): string {
  return '可用技能摘要：\n' + JSON.stringify(skills.slice(0, 96))
    + (skills.length === 0 ? '\n当前没有可供模型读取的技能条目；当前授权范围内已注册的工具仍可调用。' : '')
    + (skills.length > 96 ? `\n当前共 ${skills.length} 个技能，摘要仅展示前 96 个；使用 list_skills 获取完整目录。` : '')
    + '\navailable=false 表示工具依赖不完整，技能说明仍可读取。摘要用于发现，操作步骤见完整说明。'
    + (stale ? '\n部分说明展示记录已过期，可通过 list_tools 查看当前定义并按需加载说明。' : '')
}

export const MCP_IMAGE_REFERENCE = '[图片内容见图片块]'

export function toolDirectoryHint(tools: readonly { identity?: string; name: string; description: string }[]): string {
  return '工具目录（尚未展开完整参数）：\n'
    + JSON.stringify(tools.slice(0, 96).map(tool => ({ id: tool.identity ?? tool.name, name: tool.name,
      description: tool.description.split(/[。\n]/u)[0]!.slice(0, 120) })))
    + (tools.length > 96 ? `\n另有 ${tools.length - 96} 项，可用 list_tools 按任务关键词检索。` : '')
    + '\n知道名称和参数就直接调用；需要参数用 load_tools，不确定有什么工具才用 list_tools。需要操作步骤时用 load_skill，已有说明够用就直接做。'
    + '\n能力以当前目录和工具结果为准，权限以宿主审批为准。loaded 只表示参数说明已展开；未展开或未列在当前页不表示没有权限。'
}
