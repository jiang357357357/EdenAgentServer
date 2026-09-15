/** Instruction content only: execution schemas and permissions belong to their tools. */
export const BUILTIN_SKILL_GUIDES = [
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
    name: 'eden-self-awake', description: '后台自醒时读取本轮上下文、判断是否需要行动，并安排下一次观察。',
    tools: ['get_self_awake_context', 'set_self_awake_timer'], profiles: ['self_awake'],
    content: `# 后台自醒
先用 get_self_awake_context 读取本轮触发原因和当前上下文，区分已知事实与没有观测到的信息。
根据本轮宿主任务要求决定是否行动，避免反复执行同一观察或无事打扰用户。需要另一个专项流程时读取对应技能。
用 set_self_awake_timer 安排下一次观察时结合已有计划，核对返回时间。工具已执行的效果与本轮最终判断分别记录，不能把中断当作全部操作未发生。
最终输出严格遵循本轮宿主提供的决策格式；本技能不复制该格式，避免与协议更新冲突。`,
  },
] as const
