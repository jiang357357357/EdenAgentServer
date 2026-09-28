import { searchMenu } from './menu-search.ts'
import type { ScreenMenuItem } from './terminal-frame.ts'

export interface SlashCommand extends ScreenMenuItem { argument?: string }

/** User-facing commands; internal menu actions stay out of composer suggestions. */
export const slashCommands: SlashCommand[] = [
  { command: '/help', label: '/help', detail: '帮助与快捷键' },
  { command: '/models', label: '/models', detail: '查看和选择模型' },
  { command: '/sessions', label: '/sessions', detail: '切换会话' },
  { command: '/new', label: '/new', detail: '返回新会话页，可加标题' },
  { command: '/home', label: '/home', detail: '返回首页' },
  { command: '/menu', label: '/menu', detail: '搜索全部操作' },
  { command: '/status', label: '/status', detail: '查看会话状态' },
  { command: '/timeline', label: '/timeline', detail: '消息时间线' },
  { command: '/older', label: '/older', detail: '加载更早消息' },
  { command: '/use', label: '/use', detail: '打开会话', argument: '编号或 ID' },
  { command: '/rename', label: '/rename', detail: '重命名当前会话', argument: '新标题' },
  { command: '/stop', label: '/stop', detail: '停止当前回合' },
  { command: '/steer', label: '/steer', detail: '引导正在执行的回合', argument: '文字' },
  { command: '/followup', label: '/followup', detail: '添加跟进消息', argument: '文字' },
  { command: '/permissions', label: '/permissions', detail: '待处理审批' },
  { command: '/questions', label: '/questions', detail: '待回答问题' },
  { command: '/allow', label: '/allow', detail: '允许一次', argument: '审批编号' },
  { command: '/always', label: '/always', detail: '总是允许', argument: '审批编号' },
  { command: '/deny', label: '/deny', detail: '拒绝审批', argument: '审批编号' },
  { command: '/answer', label: '/answer', detail: '回答问题', argument: '问题编号' },
  { command: '/sidebar', label: '/sidebar', detail: '切换侧栏' },
  { command: '/details', label: '/details', detail: '切换工具详情' },
  { command: '/timestamps', label: '/timestamps', detail: '切换消息时间' },
  { command: '/refresh', label: '/refresh', detail: '刷新会话与请求' },
  { command: '/account', label: '/account', detail: '查看 Core 账号' },
  { command: '/login', label: '/login', detail: '切换 Core 账号' },
  { command: '/logout', label: '/logout', detail: '退出 Core 登录' },
  { command: '/retry', label: '/retry', detail: '重连 Agent Server' },
  { command: '/quit', label: '/quit', detail: '退出 Eden' },
]

export function slashMatches(input: string): SlashCommand[] {
  if (!/^\/[^\s/]*$/.test(input)) return []
  return searchMenu(slashCommands, input.slice(1))
}
