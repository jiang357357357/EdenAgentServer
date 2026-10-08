import type { Terminal } from './terminal.ts'

export function showCommandHelp(terminal: Terminal): void {
  terminal.showPanel('键盘与命令', [
        'Enter 发送 · Alt+Enter 或 Ctrl+J 换行 · 输入 / 显示命令 · Ctrl+P 搜索命令',
        'Ctrl+S 会话 · Ctrl+N 新建 · Ctrl+T 时间线 · Ctrl+X 停止 · Ctrl+C 退出',
        'Ctrl+B 侧栏 · Ctrl+D 工具详情 · Ctrl+L 到底部 · PgUp/PgDn 滚动',
        '/sessions · /use 编号或 UUID · /new [标题] · /rename 标题 · /older',
        '/steer 文字 · /followup 文字 · /permissions · /questions',
        '/allow 编号 · /always 编号 · /deny 编号 · /answer 编号 · /quit',
        '/home · /timeline · /status · /sidebar · /details · /timestamps',
        '/models 查看和选择当前会话模型',
        '/account 查看账号 · /login 切换账号 · /logout 退出登录 · /retry 重连',
        '发送以 / 开头的文字请先输入 //',
      ])
}

export function showCommandMenu(terminal: Terminal): void {
  terminal.showMenu('命令', [
        { label: '返回首页', command: '/home' },
        { label: '查看 Core 账号', command: '/account' },
        { label: '查看和选择模型', command: '/models' },
        { label: '切换 Core 账号', command: '/login' },
        { label: '退出 Core 登录', command: '/logout' },
        { label: '重连 Agent Server', command: '/retry' },
        { label: '切换会话', detail: 'Ctrl+S', command: '/sessions' },
        { label: '新建会话', detail: 'Ctrl+N', command: '/new' },
        { label: '消息时间线', detail: 'Ctrl+T', command: '/timeline' },
        { label: '更早的消息', command: '/older' },
        { label: '会话状态', command: '/status' },
        { label: '切换侧栏', detail: 'Ctrl+B', command: '/sidebar' },
        { label: '切换工具详情', detail: 'Ctrl+D', command: '/details' },
        { label: '切换消息时间', command: '/timestamps' },
        { label: '待处理审批', command: '/permissions' },
        { label: '待回答问题', command: '/questions' },
        { label: '停止当前回合', detail: 'Ctrl+X', command: '/stop' },
        { label: '刷新会话与请求', command: '/refresh' }, { label: '帮助', command: '/help' },
        { label: '退出', command: '/quit' },
      ], [], true)
}
