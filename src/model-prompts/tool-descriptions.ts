const descriptions = {
  read_attachment: '列出或读取当前输入的附件。读取时使用列表返回的 blobId；文本支持 UTF-8 分页，二进制内容支持 base64 分页。',
  list_connectors: '列出当前会话的连接器实例及其查询和操作参数结构。',
  read_connector_events: '列出近期连接器事件，也可按 eventId 读取单个事件。',
  list_assistants: '按稳定 ID 和简称列出可用助手。',
  switch_assistant: '从下一次根会话回合起切换助手，并保留公开历史。',
  list_mcp_servers: '列出活动的 MCP 插件运行时及其初始化错误。',
  list_mcp_capabilities: '发现指定 MCP 实例的远端工具、资源和资源模板；runtimeId 使用 list_mcp_servers 返回的真实实例 ID。',
  call_mcp_tool: '调用 MCP 工具；name 是工具名称。',
  read_mcp_resource: '读取 MCP 资源；name 是资源 URI。',
  list_contact_channels: '检查已配置的用户联系渠道及其状态。',
  read_qq_messages: '读取用户近期的 QQ 私聊消息；使用 nextBeforeId 读取更早页面。',
  send_external_email: '向已配置的用户邮箱发送邮件。',
  list_esp32_devices: '列出当前用户已认领的 ESP32 设备、真实在线状态与设备声明的能力。控制设备前先调用此工具，设备编号和能力以本次结果为准。',
  control_esp32_device: '向已认领且在线的 ESP32 设备发起电话、发送短信或显示临时提示框。每次控制都需要用户批准。call.start 应尽量提供 reason、currentSituation 和 suggestedOpening，接听后由 Core 负责该角色的语音通话，简短交接用于开场；本会话可查询通话状态，但不会收到通话正文。这是通话与文字会话的数据边界，不代表角色被替换。message.send 是设备消息卡片；notification.show 是自动消失的临时弹窗。',
  get_esp32_command_status: '查询先前 ESP32 命令的执行状态。普通命令的 succeeded 表示设备已确认；来电命令还应检查 call.status，只返回响铃、接听、通话中、拒接、未接或结束等状态，不包含通话内容。',
  show_desktop_reminder: '在当前世界排入一条持久通知。pending 表示已排队，displayed 表示客户端已显示，closed 表示用户已关闭。',
  get_desktop_reminder: '读取当前会话中一条桌面提醒的投递和关闭状态。',
  manage_connector_plugins: '通过统一插件注册表开发和安装连接器组件。支持 describe、inspect、install、enable、disable 和 list。',
  manage_plugins: '创建和管理 TypeScript 工具插件。支持 describe、read、draft、validate、test、install、activate、disable、list 和 invoke。',
  request_user_input: '向用户提出一到三个问题并等待回答，可提供选项或允许自定义回答。',
  set_self_awake_timer: '为当前会话安排未来的自醒；时间使用 ISO 日期、毫秒时间戳或 afterMinutes。',
  get_self_awake_context: '读取一个自醒上下文分区：request、desktop_window、desktop_session、audio_state、recent_events、recent_diaries 或 recent_contacts。',
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
  read_file: '读取已选择工作区中的文件。',
  write_file: '在现有工作区目录内原子写入 UTF-8 文本，可使用 createOnly 要求只新建；宿主自动检查读取后或审批期间的文件变化。',
  exec_command: '运行系统 shell。默认目录为已选择的工作区；POSIX 使用 /bin/sh，Windows 使用 PowerShell。',
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
