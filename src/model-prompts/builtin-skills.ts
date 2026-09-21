import { SELF_AWAKE_DIARY_CLOCK } from './self-awake.ts'

/** Instruction content only: execution schemas and permissions belong to their tools. */
export const BUILTIN_SKILL_GUIDES = [
  {
    name: 'web-research', description: '搜索实时网页信息、读取公开网页正文，并在已读取页面中定位相关内容。',
    tools: ['web_search', 'web_fetch', 'web_find'], profiles: ['user_chat', 'self_awake', 'subagent'],
    content: `# 网页搜索与研究
需要近期事实、外部资料或用户指定网页时，先用 web_search 搜索。查询应简短明确；不同语言或不同检索意图拆成多条 queries。
搜索结果只是线索。根据返回的 refId 使用 web_fetch 读取支持结论的页面正文，需要在长页面中定位内容时使用 web_find。
普通事实查找通常只需一次搜索和一至两次正文读取；只有首轮没有相关结果时才补充一次搜索。某个来源无法读取时，若已有来源足以支持回答，应说明证据范围并作答，不要为寻找完美来源反复改写查询。
优先选择原始、官方和与问题直接相关的来源。说明结论来自哪些 URL，不伪造网页内容，也不把搜索摘要当作已核实的正文。`,
  },
  {
    name: 'eden-memory', description: '检索已有记忆，保存值得长期保留的信息，避免重复记录和把猜测写成事实。',
    tools: ['search_memories', 'remember_memory'], profiles: ['user_chat', 'self_awake', 'subagent'],
    content: `# 记忆管理
需要了解用户偏好、历史约定或已有事实时，先用 search_memories 检索相关内容。
保存新记忆前检查是否已有相同记录，只保存明确、有长期价值的信息。区分用户陈述、观察结果与推测，不把未经确认的推测写成事实。
使用 remember_memory 保存时保留必要背景，避免重复保存整段对话。以工具实际返回为准，未成功保存时不要声称已记住。`,
  },
  {
    name: 'eden-reminders', description: '查询备忘、创建定时提醒，核对时间与已有安排，避免重复提醒。',
    tools: ['list_memos', 'create_reminder'], profiles: ['user_chat', 'self_awake', 'subagent'],
    content: `# 提醒与备忘
先用 list_memos 核对相关安排。把用户要求转换为明确的提醒内容与触发时间，使用当前环境的时区；日期、对象或时区存在关键歧义时先确认。
使用 create_reminder 创建提醒。提交前检查已有相同安排，避免因工具重试重复创建。
创建成功只代表提醒已登记，不代表未来已经送达。根据返回结果说明安排或失败原因。`,
  },
  {
    name: 'eden-workspace', description: '在所选工作区阅读和修改文件、执行命令，保护已有改动并验证操作结果。',
    tools: ['read_file', 'write_file', 'exec_command'], profiles: ['user_chat', 'subagent'],
    content: `# 工作区操作
先确认当前已选择的工作区和任务范围，再阅读相关文件及项目说明。没有工作区时不要猜测路径或声称已访问项目。
通过 read_file 理解现有内容，使用 write_file 修改必要部分，保留用户已有改动。命令操作使用 exec_command，并明确工作目录。
先判断命令是否会覆盖文件、修改外部系统或产生其他副作用，遵循宿主审批结果。工具返回失败时查看原因，不能凭发出调用就报告成功。
按任务需要验证最终结果，报告实际完成内容与尚未验证的部分。`,
  },
  {
    name: 'eden-contact', description: '主动找用户聊天、分享或邀请，选择 QQ、邮件或在线设备，并核实投递与回复。',
    tools: ['list_contact_channels', 'read_recent_conversation', 'read_qq_messages', 'send_qq_message', 'send_external_email',
      'list_esp32_devices', 'control_esp32_device', 'get_esp32_command_status'], profiles: ['user_chat', 'self_awake'],
    content: `# 主动联系
想起共同话题、有发现想分享、想问近况或邀请用户一起做点事，都可以成为联系的理由，无需包装成任务汇报。结合当前角色自然开口，也可以暂时安静。
需要接上聊天时，read_qq_messages 查看 QQ 最近十轮，read_recent_conversation 查看最新会话最近三轮。联系渠道用 list_contact_channels。短聊优先 QQ，长信可用邮件，设备需先发现在线设备与声明能力，再选择消息卡片、短提示或合适的来电。
一次选一个合适渠道；相同话题近期已发送且无新回复时留出空间，避免跨渠道追问。接受、送达、已读和回复是不同事实，结果未知先查询，明确失败后再判断是否换渠道。
邮件与设备当前没有回复正文读取接口，保留未知；设备命令可查询执行/接听状态。行动遵循已有授权及用户的渠道与时段偏好，权限不足就记录原因。`,
  },
  {
    name: 'eden-self-awake', description: '写日记与设置唤醒时钟。',
    tools: ['write_diary', 'get_self_awake_context', 'set_self_awake_timer'], profiles: ['self_awake'],
    content: SELF_AWAKE_DIARY_CLOCK,
  },
] as const
