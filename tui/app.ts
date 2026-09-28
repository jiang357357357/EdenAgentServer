import { randomUUID } from 'node:crypto'
import type { SchemaRpcMethodMap, SessionEvent, SessionSummary } from '@eden/api'
import { presentEvent } from './event-view.ts'
import { Terminal } from './terminal.ts'
import { TuiRpcClient } from './rpc-client.ts'
import { AuthFlow } from './auth-flow.ts'
import { ModelFlow } from './model-flow.ts'
import type { TuiConfig } from './config.ts'

type Permission = SchemaRpcMethodMap['permission.list']['result'][number]
type Question = SchemaRpcMethodMap['question.list']['result'][number]

function reference<T extends { id: string }>(items: T[], value: string): T {
  const index = Number(value)
  const matches = /^\d+$/.test(value) ? [items[index - 1]].filter((item): item is T => Boolean(item))
    : items.filter(item => item.id === value || item.id.startsWith(value))
  if (matches.length !== 1) throw new Error('编号或 ID 不唯一；先查看列表')
  return matches[0]!
}

export class TuiApp {
  private readonly rpc = new TuiRpcClient()
  private readonly terminal = new Terminal(line => this.enqueue(line))
  private readonly auth: AuthFlow
  private readonly models: ModelFlow
  private queue = Promise.resolve()
  private sessions: SessionSummary[] = []
  private permissions: Permission[] = []
  private questions: Question[] = []
  private current: SessionSummary | undefined
  private answering: { request: Question; index: number; answers: string[][] } | undefined
  private cursor = 0n
  private historyBefore: string | null = null
  private loading = false
  private readonly buffered: SessionEvent[] = []
  private readonly tools = new Map<string, { name: string; args: string }>()
  private closing = false
  private connecting = false
  private suppressDisconnect = false
  private connected = false

  constructor(private readonly config: TuiConfig, private readonly capability: string) {
    this.auth = new AuthFlow(config, this.terminal, token => this.connectWithToken(token), () => this.disconnect())
    this.models = new ModelFlow(config, this.rpc, this.terminal, () => this.auth.token, () => this.current?.id)
    this.terminal.setWorld(config.origin)
    this.rpc.onEvent(event => this.onEvent(event))
    this.rpc.onClose(() => {
      if (this.closing || this.connecting || this.suppressDisconnect) return
      this.connected = false
      this.terminal.setConnected(false)
      this.auth.disconnected('Agent Server 连接已断开')
      this.terminal.print('系统', '连接已断开；未确认的操作请查看历史，重启 TUI 后可继续')
    })
  }

  async run(): Promise<void> {
    const done = this.terminal.start()
    try {
      await this.auth.bootstrap()
      await done
    } finally {
      this.closing = true
      this.rpc.close()
      this.terminal.close()
    }
  }

  private async connectWithToken(token?: string): Promise<void> {
    this.connecting = true
    try {
      await this.rpc.connect(this.config.origin, this.config.port, this.capability, token)
      this.connected = true
      this.terminal.setConnected(true)
      await this.listSessions(false)
      const resume = this.current?.id ?? this.config.sessionId
      if (resume) await this.selectSession(resume)
      else this.showHome()
    } finally { this.connecting = false }
  }

  private disconnect(): void {
    this.suppressDisconnect = true
    try { this.rpc.close() }
    finally { this.suppressDisconnect = false }
    this.connected = false
    this.current = undefined
    this.sessions = []
    this.permissions = []
    this.questions = []
    this.answering = undefined
    this.tools.clear()
    this.buffered.length = 0
    this.terminal.setSessions([])
    this.terminal.setPending(0, 0)
    this.terminal.setConnected(false)
    this.terminal.home()
  }

  private enqueue(line: string): void {
    this.queue = this.queue.then(() => this.handle(line)).catch(error => {
      if (!this.auth.authenticated || !this.connected) this.auth.report(error)
      else this.terminal.print('错误', error instanceof Error ? error.message : String(error))
    })
  }

  private onEvent(event: SessionEvent): void {
    if (event.sessionId !== this.current?.id) return
    if (this.loading) { this.buffered.push(event); return }
    this.accept(event, true)
  }

  private accept(event: SessionEvent, live = false): void {
    const seq = BigInt(event.seq)
    if (seq <= this.cursor) return
    this.cursor = seq
    if (event.eventType === 'turn.started') this.terminal.setBusy(true)
    if (event.eventType === 'turn.completed' || event.eventType === 'turn.failed' || event.eventType === 'input.interrupted') {
      this.terminal.setBusy(false)
      this.tools.clear()
    }
    const shown = presentEvent(event, false, this.tools)
    if (shown) this.terminal.upsert(shown.key, shown.label, shown.text, shown.complete ?? true, shown.time)
    if (live && event.eventType === 'permission.requested' && !this.answering) this.enqueue('/permissions')
    if (live && event.eventType === 'question.requested' && !this.answering) this.enqueue('/questions')
    if (live && this.answering && (event.eventType === 'permission.requested' || event.eventType === 'question.requested')) {
      void this.refreshPending().catch(error => this.terminal.print('错误', error instanceof Error ? error.message : String(error)))
    }
    if (live && (event.eventType === 'permission.resolved' || event.eventType === 'question.resolved')) {
      void this.refreshPending().catch(error => this.terminal.print('错误', error instanceof Error ? error.message : String(error)))
    }
  }

  private async listSessions(show = true): Promise<void> {
    this.sessions = await this.rpc.request('session.list', { limit: 100, includeClosed: false,
      includeBackground: false, purpose: 'user_chat', sourceChannel: 'app' })
    this.terminal.setSessions(this.sessions.map(item => ({ id: item.id, title: item.title, busy: item.executionStatus === 'busy' })))
    if (!show) return
    if (!this.sessions.length) { this.terminal.print('会话', '暂无应用聊天会话；Ctrl+N 创建'); return }
    this.terminal.showMenu('切换会话', this.sessions.map((item, index) => ({
      label: `${index + 1}. ${item.title || '未命名'}${item.id === this.current?.id ? ' · 当前' : ''}`,
      detail: `${item.executionStatus === 'busy' ? '执行中 · ' : ''}${item.id.slice(0, 8)}`, command: `/use ${item.id}`,
    })), [], true)
  }

  private async selectSession(id: string): Promise<void> {
    const session = await this.rpc.request('session.read', { sessionId: id })
    if (session.status !== 'active' || session.purpose !== 'user_chat' || session.sourceChannel !== 'app') {
      throw new Error('只能打开未关闭的应用聊天会话')
    }
    this.current = session
    this.answering = undefined
    this.terminal.prompt('> ')
    this.cursor = 0n
    this.historyBefore = null
    this.tools.clear()
    this.terminal.clearTranscript()
    this.terminal.setSession(session.id, session.title || '未命名会话', session.executionStatus === 'busy', session.contextTokens)
    this.terminal.setPending(0, 0)
    this.terminal.hidePanel()
    this.loading = true
    this.buffered.length = 0
    try {
      const history = await this.rpc.request('message.list', { sessionId: id, limit: 40 })
      this.historyBefore = history.hasMore ? history.nextCursor : null
      this.terminal.setOlder(Boolean(this.historyBefore))
      for (const event of history.items) {
        const shown = presentEvent(event, true)
        if (shown) this.terminal.upsert(shown.key, shown.label, shown.text, shown.complete ?? true, shown.time)
        const seq = BigInt(event.seq)
        if (seq > this.cursor) this.cursor = seq
      }
      let more = true
      while (more) {
        const page = await this.rpc.request('event.list', { sessionId: id, afterSeq: this.cursor.toString(), limit: 500 })
        for (const event of page.items) this.accept(event)
        more = page.hasMore && page.items.length > 0
      }
      for (const event of this.buffered) this.accept(event)
      await this.refreshPending()
      await this.models.refresh(id).catch(error => this.terminal.print('系统', `模型目录读取失败：${error instanceof Error ? error.message : String(error)}`))
    } finally {
      this.loading = false
      this.buffered.length = 0
    }
  }

  private session(): SessionSummary {
    if (!this.current) throw new Error('先用 /new 或 /use 选择会话')
    return this.current
  }

  private showHome(): void {
    this.current = undefined
    this.answering = undefined
    this.cursor = 0n
    this.historyBefore = null
    this.tools.clear()
    this.buffered.length = 0
    this.terminal.home()
    this.terminal.setPending(0, 0)
    if (!this.connected) return
    void this.models.refresh().catch(() => { /* A missing model is shown when sending or opening /models. */ })
    if (this.config.origin === 'mon') void this.monParticipant().then(participant => {
      if (!this.current) this.terminal.setAgent(String(participant.assistantName ?? '伊甸园'))
    }).catch(() => { /* The user can choose an assistant in Core before sending. */ })
  }

  private async monParticipant(): Promise<Record<string, unknown>> {
    const token = this.auth.token
    if (!token) throw new Error('Mon 世界尚未登录')
    const response = await fetch(new URL('/api/assistants/current/', this.config.coreUrl), {
      headers: { Authorization: `Token ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`读取当前助手失败（HTTP ${response.status}）；请先在 Core 选择助手`)
    const assistant: unknown = await response.json()
    if (!assistant || typeof assistant !== 'object' || Array.isArray(assistant)) throw new Error('Core 助手资料格式无效')
    const value = assistant as Record<string, unknown>
    const id = Number(value.id)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Core 助手 ID 无效')
    const character = value.character && typeof value.character === 'object' && !Array.isArray(value.character)
      ? value.character as Record<string, unknown> : {}
    return { assistantId: id, assistantName: String(value.name ?? character.name ?? `助手 ${id}`),
      characterId: character.id ?? null, characterName: String(character.name ?? ''),
      signature: String(character.signature ?? ''), position: 0, profile: value }
  }

  private async createSession(title: string): Promise<void> {
    const participants = this.current?.participants?.length ? this.current.participants
      : this.config.origin === 'mon' ? [await this.monParticipant()] : []
    const created = await this.rpc.request('session.create', { title: title || '终端会话', participants })
    await this.listSessions(false)
    await this.selectSession(created.id)
  }

  private async olderMessages(): Promise<void> {
    const before = this.historyBefore
    if (!before) { this.terminal.print('系统', '没有更早的消息'); return }
    const sessionId = this.session().id
    const page = await this.rpc.request('message.list', { sessionId, before, limit: 40 })
    if (this.current?.id !== sessionId) return
    const entries = page.items.flatMap(event => {
      const shown = presentEvent(event, true)
      return shown ? [{ ...(shown.key ? { key: shown.key } : {}), label: shown.label, text: shown.text,
        complete: true, ...(shown.time === undefined ? {} : { time: shown.time }) }] : []
    })
    if (entries.length) this.terminal.prepend(entries)
    this.historyBefore = page.hasMore ? page.nextCursor : null
    this.terminal.setOlder(Boolean(this.historyBefore))
    if (!entries.length) this.terminal.print('系统', '没有更早的可显示消息')
  }

  private async refreshPending(): Promise<void> {
    const id = this.current?.id
    if (!id) return
    const [permissions, questions] = await Promise.all([
      this.rpc.request('permission.list', { sessionId: id }),
      this.rpc.request('question.list', { sessionId: id }),
    ])
    if (this.current?.id !== id) return
    this.permissions = permissions.filter(item => item.state === 'pending')
    this.questions = questions.filter(item => item.state === 'pending')
    this.terminal.setPending(this.permissions.length, this.questions.length)
  }

  private async listPermissions(show = true): Promise<void> {
    this.permissions = (await this.rpc.request('permission.list', { sessionId: this.session().id }))
      .filter(item => item.state === 'pending')
    this.terminal.setPending(this.permissions.length, this.questions.length)
    if (!show) return
    if (!this.permissions.length) { this.terminal.print('审批', '没有待处理请求'); return }
    if (this.permissions.length === 1) { this.showPermission(this.permissions[0]!); return }
    this.terminal.showMenu('待处理审批', this.permissions.map((item, index) => ({
      label: `${index + 1}. ${item.capability} ${item.resource}`, command: `/permission ${item.id}`,
    })))
  }

  private showPermission(item: Permission): void {
    this.terminal.showMenu(`审批 · ${item.capability}`, [
      { label: '允许一次', command: `/allow ${item.id}` },
      { label: '总是允许', command: `/confirm-always ${item.id}` },
      { label: '拒绝', command: `/deny ${item.id}` },
      { label: '查看完整请求', command: `/permission-detail ${item.id}` },
    ], [item.resource, JSON.stringify(item.details)])
  }

  private async listQuestions(show = true): Promise<void> {
    this.questions = (await this.rpc.request('question.list', { sessionId: this.session().id }))
      .filter(item => item.state === 'pending')
    this.terminal.setPending(this.permissions.length, this.questions.length)
    if (!show) return
    if (!this.questions.length) { this.terminal.print('提问', '没有待回答的问题'); return }
    this.terminal.showMenu('待回答问题', this.questions.map((item, index) => ({
      label: `${index + 1}. ${item.questions.map(question => question.header).join(' / ')}`,
      command: `/answer ${item.id}`,
    })))
  }

  private showQuestion(): void {
    const answer = this.answering
    if (!answer) return
    const question = answer.request.questions[answer.index]
    if (!question) return
    this.terminal.showPanel(`提问 ${answer.index + 1}/${answer.request.questions.length} · ${question.header}`, [
      question.question,
      ...question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? `：${option.description}` : ''}`),
      question.multiple ? '多选用逗号分隔 · Esc 返回' : '输入编号或答案 · Esc 返回',
    ])
    this.terminal.prompt('回答> ')
  }

  private async answer(line: string): Promise<void> {
    const answer = this.answering!
    const question = answer.request.questions[answer.index]!
    const pieces = question.multiple ? line.split(',').map(item => item.trim()).filter(Boolean) : [line]
    if (!pieces.length || !pieces[0]) throw new Error('答案不能为空')
    const selected = pieces.map(piece => {
      const option = /^\d+$/.test(piece) ? question.options[Number(piece) - 1]
        : question.options.find(item => item.label === piece)
      if (option) return option.label
      if (!question.custom) throw new Error('此问题只能选择列出的选项')
      return piece
    })
    const nextAnswers = [...answer.answers, selected]
    if (answer.index + 1 < answer.request.questions.length) {
      answer.answers = nextAnswers
      answer.index++
      this.showQuestion()
    } else {
      await this.rpc.request('question.resolve', { requestId: answer.request.id, answers: nextAnswers })
      this.answering = undefined
      this.terminal.prompt('> ')
      this.terminal.hidePanel()
      await this.refreshPending()
      this.terminal.print('提问', '答案已提交')
    }
  }

  private async handle(line: string): Promise<void> {
    if (line === '/quit') { this.terminal.close(); return }
    if (await this.auth.input(line)) return
    if (!line) return
    if (line === '/login') { await this.auth.logout(); return }
    if (line === '/logout') { await this.auth.logout(); return }
    if (line === '/retry') { await this.auth.retry(); return }
    if (line === '/account') { this.terminal.showPanel('Core 账号', this.auth.accountLines()); return }
    if (!this.auth.authenticated || !this.connected) throw new Error('请先在首页登录，或输入 /retry 重连')
    if (this.answering) {
      if (line === '/back') { this.answering = undefined; this.terminal.prompt('> '); this.terminal.hidePanel(); return }
      await this.answer(line)
      return
    }
    if (!line.startsWith('/') || line.startsWith('//')) {
      const text = line.startsWith('//') ? line.slice(1) : line
      try {
        if (!this.current) await this.createSession('新会话')
        if (!await this.models.ensure(this.session().id)) { this.terminal.setDraft(text); return }
      } catch (error) { this.terminal.setDraft(text); throw error }
      const result = await this.rpc.request('turn.start', { sessionId: this.session().id,
        text, attachments: [], idempotencyKey: randomUUID() })
      this.terminal.print('系统', `输入已接受：${result.state}`)
      return
    }
    const space = line.indexOf(' ')
    const command = space < 0 ? line : line.slice(0, space)
    const argument = space < 0 ? '' : line.slice(space + 1).trim()
    switch (command) {
      case '/help': this.terminal.showPanel('键盘与命令', [
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
      ]); break
      case '/menu': this.terminal.showMenu('命令', [
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
      ], [], true); break
      case '/sessions': await this.listSessions(); break
      case '/models': await this.models.showMenu(this.current?.id, true); break
      case '/model-preview': this.models.preview(argument); break
      case '/model-confirm': await this.models.select(argument); break
      case '/home': this.showHome(); break
      case '/timeline': this.terminal.showTimeline(); break
      case '/jump': this.terminal.jumpTo(argument); break
      case '/sidebar': this.terminal.toggleSidebar(); break
      case '/details': this.terminal.toggleDetails(); break
      case '/timestamps': this.terminal.toggleTimestamps(); break
      case '/status': {
        const current = await this.rpc.request('session.read', { sessionId: this.session().id })
        await this.refreshPending()
        this.current = current
        this.terminal.setSession(current.id, current.title, current.executionStatus === 'busy', current.contextTokens)
        this.terminal.showPanel('会话状态', [
          `标题：${current.title}`, `ID：${current.id}`, `世界：${current.runtimeOrigin}`,
          `执行：${current.executionStatus}`, `上下文：${current.contextTokens?.toLocaleString() ?? '未知'} tokens`,
          `待审批：${this.permissions.length} · 待回答：${this.questions.length}`,
        ])
        break
      }
      case '/rename': {
        if (!argument) throw new Error('用法：/rename 新标题')
        const updated = await this.rpc.request('session.rename', { sessionId: this.session().id, title: argument })
        this.current = updated
        this.terminal.setSession(updated.id, updated.title, updated.executionStatus === 'busy', updated.contextTokens)
        await this.listSessions(false)
        break
      }
      case '/refresh': await this.listSessions(false); await this.refreshPending(); this.terminal.print('系统', '已刷新'); break
      case '/older': await this.olderMessages(); break
      case '/use': {
        if (!argument) throw new Error('用法：/use 编号或 UUID')
        const id = /^\d+$/.test(argument) ? this.sessions[Number(argument) - 1]?.id : argument
        if (!id) throw new Error('会话编号无效；先输入 /sessions')
        await this.selectSession(id)
        break
      }
      case '/new': if (argument) await this.createSession(argument); else this.showHome(); break
      case '/stop': {
        const result = await this.rpc.request('turn.cancel', { sessionId: this.session().id })
        this.terminal.print('系统', result.cancellationRequested ? '已请求停止' : '当前没有运行中的回合')
        break
      }
      case '/steer': case '/followup': {
        if (!argument) throw new Error(`用法：${command} 文字`)
        const method = command === '/steer' ? 'turn.steer' : 'turn.follow_up'
        const result = await this.rpc.request(method, { sessionId: this.session().id, text: argument })
        this.terminal.print('系统', `输入已接受：${result.state}`)
        break
      }
      case '/permissions': await this.listPermissions(); break
      case '/permission-detail': {
        await this.listPermissions(false)
        const item = reference(this.permissions, argument)
        this.terminal.showPanel(`审批详情 · ${item.capability}`, [
          `资源：${item.resource}`, `详情：${JSON.stringify(item.details)}`, `请求：${JSON.stringify(item.request)}`,
          'Esc 关闭；输入 /permissions 返回审批选项',
        ])
        break
      }
      case '/confirm-always': {
        await this.listPermissions(false)
        const item = reference(this.permissions, argument)
        this.terminal.showMenu('确认总是允许', [
          { label: '取消', command: `/permission ${item.id}` },
          { label: '确认总是允许', command: `/always ${item.id}` },
        ], [`能力：${item.capability}`, `资源：${item.resource}`])
        break
      }
      case '/permission': {
        if (!argument) throw new Error('用法：/permission 编号或 ID')
        await this.listPermissions(false)
        this.showPermission(reference(this.permissions, argument))
        break
      }
      case '/allow': case '/always': case '/deny': {
        if (!argument) throw new Error(`用法：${command} 编号或 ID`)
        await this.listPermissions(false)
        const permission = reference(this.permissions, argument)
        const decision = command === '/deny' ? 'deny' : command === '/always' ? 'always' : 'once'
        await this.rpc.request('permission.resolve', { requestId: permission.id, decision })
        await this.refreshPending()
        this.terminal.print('审批', `已提交 ${decision}`)
        break
      }
      case '/questions': await this.listQuestions(); break
      case '/answer': {
        if (!argument) throw new Error('用法：/answer 编号或 ID')
        await this.listQuestions(false)
        this.answering = { request: reference(this.questions, argument), index: 0, answers: [] }
        this.showQuestion()
        break
      }
      default: throw new Error(`未知命令 ${command}；输入 /help 查看`)
    }
  }
}
