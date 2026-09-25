const descriptions = {
  read_attachment: '列出或读取当前输入的附件。使用列表返回的 blobId；文本支持 UTF-8 分页，二进制内容支持 base64 分页。视频可用 frames 提取少量画面，需本机 FFmpeg；画面不包含音轨。',
  list_connectors: '列出当前会话的连接器实例及其查询和操作参数结构。',
  read_connector_events: '列出近期连接器事件，也可按 eventId 读取单个事件。',
  list_assistants: '按稳定 ID 和简称列出可用助手。',
  switch_assistant: '从下一次根会话回合起切换助手，并保留公开历史。',
  list_mcp_servers: '列出活动的 MCP 插件运行时及其初始化错误。',
  list_mcp_capabilities: '发现指定 MCP 实例的远端工具、资源和资源模板；runtimeId 使用 list_mcp_servers 返回的真实实例 ID。',
  call_mcp_tool: '调用 MCP 工具；name 是工具名称。',
  read_mcp_resource: '读取 MCP 资源；name 是资源 URI。',
  list_contact_channels: '检查已配置的用户联系渠道及其状态。',
  read_recent_conversation: '查看同账号、同角色最新聊天会话的最近三轮对话，按时间返回用户原话与角色回复。',
  send_qq_message: '向已配置的用户私人 QQ 发送消息，接续话题或分享想说的话；接收者由宿主配置确定，accepted 仅代表渠道接受，已读与回复另行核实。',
  read_qq_messages: '查看当前用户 QQ 私聊最近十轮真实对话，按时间返回双方消息。',
  send_external_email: '向已配置的用户邮箱发送邮件。',
  list_esp32_devices: '列出当前用户已认领的 ESP32 设备、真实在线状态与设备声明的能力。控制设备前先调用此工具，设备编号和能力以本次结果为准。',
  control_esp32_device: '向已认领且在线的 ESP32 设备发起电话、发送短信或显示临时提示框。控制遵循现有授权和审批结果。call.start 应尽量提供 reason、currentSituation 和 suggestedOpening，接听后由 Core 负责该角色的语音通话，简短交接用于开场；本会话可查询通话状态，但不会收到通话正文。这是通话与文字会话的数据边界，不代表角色被替换。message.send 是设备消息卡片；notification.show 是自动消失的临时弹窗。',
  get_esp32_command_status: '查询先前 ESP32 命令的执行状态。普通命令的 succeeded 表示设备已确认；来电命令还应检查 call.status，只返回响铃、接听、通话中、拒接、未接或结束等状态，不包含通话内容。',
  show_desktop_reminder: '在当前世界排入一条持久通知。pending 表示已排队，displayed 表示客户端已显示，closed 表示用户已关闭。',
  get_desktop_reminder: '读取当前会话中一条桌面提醒的投递和关闭状态。',
  manage_connector_plugins: '通过统一插件注册表开发和安装连接器组件。支持 describe、inspect、install、enable、disable 和 list。',
  manage_plugins: '创建和管理 TypeScript 工具插件。支持 describe、read、draft、validate、test、install、activate、disable、list 和 invoke。',
  request_user_input: '向用户提出一到三个问题并等待回答，可提供选项或允许自定义回答。',
  write_diary: '保存本次自醒的日记，填写正文 content，可选标题 title；再次调用会更新本篇，返回保存结果。',
  set_self_awake_timer: '安排下次自醒，at 使用带时区的 ISO 日期，或用 afterMinutes 表达间隔。结果 scheduledAt 与 scheduledLocal 为保存时间；adjustment 说明兜底上限造成的提前。',
  get_self_awake_context: '读取一个自醒上下文分区：request、desktop_window、desktop_session、audio_state、recent_events、recent_diaries 或 wake_notes（唤醒时间）。历史默认返回目录和状态；日记原文用 includeContent=true 与 query 按主题读取。',
  list_skills: '列出当前场景可读取的已启用技能摘要及缺失工具依赖。依赖不完整的技能仍可读取说明；返回完整目录，正文按需用 load_skill 读取。',
  read_skill: '读取已安装的指令技能。',
  load_skill: '读取完整技能操作说明并返回关联工具信息，不改变工具接口的加载状态。缺少接口时使用 list_tools 和 load_tools；已知用法时无需重复读取技能。',
  read_skill_file: '从已安装技能快照中读取一个支持文件并返回 base64。',
  run_skill_tool: '用 JSON 参数执行已安装技能的代码工具。',
  create_skill: '创建或替换可复用的指令技能。',
  spawn_agent: '为边界明确的任务创建子智能体。',
  send_parent_message: '向直接父智能体发送持久消息。',
  read_agent_messages: '读取当前智能体或根会话最多十条未读消息。',
  list_agents: '列出后代智能体任务及其持久状态。',
  wait_agent: '等待后代任务，最长 60 秒。',
  send_message: '向后代智能体排入持久消息。',
  followup_task: '在空闲的后代智能体上启动另一项任务。',
  interrupt_agent: '中断一个后代智能体任务。',
  read_file: '按字节偏移分页读取已选择工作区中的 UTF-8 文件；返回 nextOffset 后可继续读取。',
  list_directory: '列出已选择工作区中的目录和文件。',
  search_files: '在已选择工作区中按文件名或文件内容搜索；返回匹配路径、行号和片段。',
  write_file: '在现有工作区目录内原子写入 UTF-8 文本，可使用 createOnly 要求只新建；宿主自动检查读取后或审批期间的文件变化。',
  edit_file: '精确替换工作区文件中唯一匹配的 oldText；写入前检查文件是否变化并请求审批。',
  exec_command: '运行所选终端环境中的系统 shell。可设置最长 600 秒的 timeoutSeconds，输出超过 1 MiB 时截断但命令继续执行。Windows 可选择本机 PowerShell 或 WSL 发行版，其他系统使用 /bin/sh。',
} as const

export type BuiltinToolDescription = keyof typeof descriptions

export function toolDescription(name: BuiltinToolDescription): string { return descriptions[name] }

export function connectorCapabilityDescription(method: 'query' | 'execute'): string {
  return `在当前会话的连接器上${method === 'query' ? '查询' : '执行'}一项已声明能力。`
}

export function mediaCaptureDescription(kind: 'screen' | 'camera'): string {
  return `获取${kind === 'screen' ? '屏幕' : '摄像头'}画面。`
}

export function memoryToolDescription(name: string): string {
  return `${name}：访问当前行动角色的长期记忆。`
}

export function memoToolDescription(name: string): string {
  return `${name}：管理当前世界中的持久备忘、待办和提醒；时间使用毫秒时间戳或 ISO 日期。`
}
