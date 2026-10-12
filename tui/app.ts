import { randomUUID } from 'node:crypto'
import type { SchemaRpcMethodMap, SessionEvent, SessionSummary } from '@eden/api'
import { presentEvent } from './event-view.ts'
import { Terminal } from './terminal.ts'
import { TuiRpcClient, TuiRpcError } from './rpc-client.ts'
import { AuthFlow } from './auth-flow.ts'
import { ModelFlow } from './model-flow.ts'
import type { TuiConfig } from './config.ts'
import { currentParticipant } from './core-participant.ts'
import { sessionCommands } from './session-commands.ts'
import { reference } from './session-reference.ts'
import { capabilityToken } from './config.ts'
import type { InputSubmission } from './input-drafts.ts'
import { ReconnectLoop } from './reconnect-loop.ts'
import { rememberOperation, storedTool, type ToolHistory } from './tool-view.ts'
import { formatElapsed, participantLabel } from './status-view.ts'

type Permission = SchemaRpcMethodMap['permission.list']['result'][number]
type Question = SchemaRpcMethodMap['question.list']['result'][number]


export class TuiApp {
  private readonly rpc = new TuiRpcClient()
  private readonly terminal = new Terminal((line, submission) => this.enqueue(line, submission))
  private readonly auth: AuthFlow
  private readonly models: ModelFlow
  private readonly reconnect: ReconnectLoop
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
  private readonly tools: ToolHistory = new Map()
  private closing = false
  private connecting = false
  private suppressDisconnect = false
  private connected = false
  private connectionGeneration = 0

  constructor(private readonly config: TuiConfig, private readonly capability: string) {
    this.auth = new AuthFlow(config, this.terminal, token => this.connectWithToken(token), reset => this.disconnect(reset))
    this.models = new ModelFlow(config, this.rpc, this.terminal, () => this.auth.token, () => this.current?.id)
    this.reconnect = new ReconnectLoop({
      attempt: async () => {
        if (this.closing || this.terminal.isClosed || !this.auth.retryable) return false
        await this.auth.retry()
        return !this.connected && this.auth.retryable
      },
      progress: (attempt, limit) => this.terminal.print('连接', `正在重连 ${attempt}/${limit}；/reconnect-stop 停止`),
      exhausted: () => this.terminal.print('连接', '自动重连次数已用完；输入 /retry 手动重试'),
    })
    this.terminal.setWorld(config.origin)
    this.rpc.onEvent(event => this.onEvent(event))
    this.rpc.onClose(() => {
      if (this.closing || this.connecting || this.suppressDisconnect) return
      this.connected = false
      this.terminal.setConnected(false)
      this.auth.disconnected('Agent Server 连接已断开')
      this.terminal.print('系统', '连接已断开；正在尝试恢复会话。未确认的输入不会自动重发')
      this.reconnect.start()
    })
  }

  async run(): Promise<void> {
    const done = this.terminal.start()
    try {
      await Promise.race([this.auth.bootstrap(), done])
      if (this.terminal.isClosed) return
      if (this.auth.retryable) this.reconnect.start()
      await done
    } finally {
      this.closing = true
      this.reconnect.stop()
      this.auth.cancel()
      this.rpc.close()
      this.terminal.close()
    }
  }

  private async connectWithToken(token?: string): Promise<void> {
    const generation = ++this.connectionGeneration
    const check = () => { if (generation !== this.connectionGeneration || this.terminal.isClosed) throw new Error('连接已取消') }
    this.connecting = true
    try {
      const capability = this.config.tokenFile ? capabilityToken(this.config) : this.capability
      await this.rpc.connect(this.config.origin, this.config.port, capability, token)
      check()
      this.connected = true
      this.terminal.setConnected(true)
      await this.listSessions(false)
      check()
      const resume = this.current?.id ?? this.config.sessionId
      if (resume) await this.selectSession(resume)
      else this.showHome()
      check()
    } finally { if (generation === this.connectionGeneration) this.connecting = false }
  }

  private disconnect(reset = true): void {
    this.connectionGeneration++
    this.connecting = false
    this.suppressDisconnect = true
    try { this.rpc.close() }
    finally { this.suppressDisconnect = false }
    this.connected = false
    this.terminal.setConnected(false)
    if (!reset) return
    this.reconnect.stop()
    this.loading = false
    this.current = undefined
    this.sessions = []
    this.permissions = []
    this.questions = []
    this.answering = undefined
    this.tools.clear()
    this.buffered.length = 0
    this.terminal.setSessions([])
    this.terminal.setPending(0, 0)
    this.terminal.clearAccount()
  }

  private enqueue(line: string, submission?: InputSubmission): void {
    if (line === '/reconnect-stop') { this.stopReconnect(); return }
    if (line === '/quit') { this.terminal.close(); this.reconnect.stop(); return }
    this.queue = this.queue.then(() => this.handle(line)).catch(error => {
      if (submission) this.terminal.recoverSubmission(submission, !(error instanceof TuiRpcError && error.uncertain), this.current?.id)
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
    this.terminal.observeTurn(event)
    if (event.eventType === 'turn.started') this.terminal.setBusy(true)
    if (event.eventType === 'turn.completed' || event.eventType === 'turn.failed' || event.eventType === 'input.interrupted') {
      this.terminal.setBusy(false)
      this.tools.clear()
    }
    const shown = presentEvent(event, false, this.tools)
    if (shown) {
      const elapsed = this.terminal.turnElapsedMs
      const text = /^(turn\.(completed|failed)|input\.interrupted)$/.test(event.eventType) && elapsed !== undefined
        ? `${shown.text} · 耗时 ${formatElapsed(elapsed)}` : shown.text
      this.terminal.upsert(shown.key, shown.label, text, shown.complete ?? true, shown.time, shown.failed)
    }
    if (live) this.pendingEvent(event.eventType)
  }

  private pendingEvent(type: SessionEvent['eventType']): void {
    const commands: Record<string, string> = { 'permission.requested': '/permissions', 'question.requested': '/questions' }
    const command = commands[type]
    if (command && !this.answering) this.enqueue(command)
    if ((command && this.answering) || type === 'permission.resolved' || type === 'question.resolved') {
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
    const generation = this.connectionGeneration
    const check = () => { if (generation !== this.connectionGeneration) throw new Error('连接已取消') }
    const session = await this.rpc.request('session.read', { sessionId: id })
    check()
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
    this.terminal.setAgent(participantLabel(session.participants))
    this.terminal.setPending(0, 0)
    this.terminal.hidePanel()
    this.loading = true
    this.buffered.length = 0
    try {
      const [history, timing, operations, workspace] = await Promise.all([
        this.rpc.request('message.list', { sessionId: id, limit: 40 }),
        this.rpc.request('session.timing.read', { sessionId: id }),
        this.rpc.request('operation.list', { sessionId: id, limit: 500 }),
        this.rpc.request('workspace.info', { sessionId: id }),
      ])
      check()
      this.terminal.setTiming(timing)
      this.terminal.setWorkspace(workspace)
      for (const operation of operations) rememberOperation(operation, this.tools)
      this.restoreHistory(history, operations)
      let more = true
      while (more) {
        const page = await this.rpc.request('event.list', { sessionId: id, afterSeq: this.cursor.toString(), limit: 500 })
        check()
        for (const event of page.items) this.accept(event)
        more = page.hasMore && page.items.length > 0
      }
      await this.refreshPending()
      await this.models.refresh(id).catch(error => this.terminal.print('系统', `模型目录读取失败：${error instanceof Error ? error.message : String(error)}`))
      check()
      for (const event of this.buffered) this.accept(event, true)
    } finally {
      if (generation === this.connectionGeneration) { this.loading = false; this.buffered.length = 0 }
    }
  }

  private restoreHistory(history: SchemaRpcMethodMap['message.list']['result'], operations: SchemaRpcMethodMap['operation.list']['result']): void {
    this.historyBefore = history.hasMore ? history.nextCursor : null
    this.terminal.setOlder(Boolean(this.historyBefore))
    const turns = new Set(history.items.map(event => event.turnId))
    const entries = operations.filter(operation => operation.createdAt >= (history.items[0]?.createdAt ?? 0)
      || turns.has(operation.turnId) || operation.state === 'running').map(storedTool)
    for (const event of history.items) {
      const shown = presentEvent(event, true)
      if (shown) entries.push({ ...shown, key: shown.key!, complete: shown.complete ?? true,
        time: shown.time ?? event.createdAt, failed: shown.failed ?? false })
      const seq = BigInt(event.seq)
      if (seq > this.cursor) this.cursor = seq
    }
    for (const shown of entries.sort((left, right) => left.time - right.time)) {
      this.terminal.upsert(shown.key, shown.label, shown.text, shown.complete, shown.time, shown.failed)
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
    return currentParticipant(this.config.coreUrl, this.auth.token)
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
    if (await this.handleAccountCommand(line)) return
    if (!this.auth.authenticated || !this.connected) throw new Error('请先在首页登录，或输入 /retry 重连')
    if (this.answering) {
      if (line === '/back') { this.answering = undefined; this.terminal.prompt('> '); this.terminal.hidePanel(); return }
      await this.answer(line)
      return
    }
    if (!line.startsWith('/') || line.startsWith('//')) {
      await this.submitMessage(line.startsWith('//') ? line.slice(1) : line)
      return
    }
    const space = line.indexOf(' ')
    const command = space < 0 ? line : line.slice(0, space)
    const argument = space < 0 ? '' : line.slice(space + 1).trim()
    const handler = this.commands[command]
    if (!handler) throw new Error(`未知命令 ${command}；输入 /help 查看`)
    await handler(argument)
  }

  private async handleAccountCommand(line: string): Promise<boolean> {
    if (line === '/restore' && !this.answering) { this.terminal.restoreDraft(); return true }
    if (line === '/reconnect-stop') { this.stopReconnect(); return true }
    if (line === '/login' || line === '/logout') { this.reconnect.stop(); await this.auth.logout(); return true }
    if (line === '/retry') { this.stopReconnect(false); await this.auth.retry(); return true }
    if (line === '/account') { this.terminal.showPanel('Core 账号', this.auth.accountLines()); return true }
    return false
  }

  private stopReconnect(notify = true): void {
    this.reconnect.stop()
    if (this.connecting) {
      this.auth.cancel()
      this.disconnect(false)
      this.auth.disconnected('重连已取消')
    }
    if (notify) this.terminal.print('连接', '自动重连已停止；输入 /retry 手动重试')
  }

  private async submitMessage(text: string): Promise<void> {
    try {
      if (!this.current) await this.createSession('新会话')
      if (!await this.models.ensure(this.session().id)) { this.terminal.setDraft(text); return }
    } catch (error) { this.terminal.setDraft(text); throw error }
    const result = await this.rpc.request('turn.start', { sessionId: this.session().id,
      text, attachments: [], idempotencyKey: randomUUID() })
    this.terminal.print('系统', `输入已接受：${result.state}`)
  }

  private get commands(): Record<string, (argument: string) => void | Promise<unknown>> {
    const app = this
    return sessionCommands({
      rpc: this.rpc, terminal: this.terminal, models: this.models,
      get current() { return app.current }, set current(value) { app.current = value },
      get sessions() { return app.sessions }, get permissions() { return app.permissions },
      get questions() { return app.questions },
      session: () => this.session(), listSessions: show => this.listSessions(show),
      showHome: () => this.showHome(), createSession: title => this.createSession(title),
      selectSession: id => this.selectSession(id), olderMessages: () => this.olderMessages(),
      refreshPending: () => this.refreshPending(), listPermissions: show => this.listPermissions(show),
      showPermission: item => this.showPermission(item), resolvePermission: (command, arg) => this.resolvePermission(command, arg),
      listQuestions: show => this.listQuestions(show), followInput: (command, arg) => this.followInput(command, arg),
      beginAnswer: request => { this.answering = { request, index: 0, answers: [] }; this.showQuestion() },
    })
  }

  private async followInput(command: string, argument: string): Promise<void> {
    if (!argument) throw new Error(`用法：${command} 文字`)
        const method = command === '/steer' ? 'turn.steer' : 'turn.follow_up'
        const result = await this.rpc.request(method, { sessionId: this.session().id, text: argument })
        this.terminal.print('系统', `输入已接受：${result.state}`)
  }

  private async resolvePermission(command: string, argument: string): Promise<void> {
    if (!argument) throw new Error(`用法：${command} 编号或 ID`)
        await this.listPermissions(false)
        const permission = reference(this.permissions, argument)
        const decision = command === '/deny' ? 'deny' : command === '/always' ? 'always' : 'once'
        await this.rpc.request('permission.resolve', { requestId: permission.id, decision })
        await this.refreshPending()
        this.terminal.print('审批', `已提交 ${decision}`)
  }

}
