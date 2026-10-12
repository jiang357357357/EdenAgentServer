import { emitKeypressEvents } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { displayText, graphemes } from './screen-text.ts'
import { searchMenu } from './menu-search.ts'
import { slashMatches, type SlashCommand } from './slash-commands.ts'
import { contentWidth, renderFrame, transcriptLines } from './terminal-frame.ts'
import type { ColoredLine, ScreenEntry, ScreenMenuItem, ScreenPanel, ScreenSession, ScreenState } from './screen-state.ts'

import { commandKey, editInput, isEnter, isPage, isText, isVertical, restrictedKey, type KeyPress } from './terminal-input.ts'
import { InputDrafts, type InputSubmission } from './input-drafts.ts'
import { ReplyClock } from './reply-clock.ts'
import type { ReplyTimerSnapshot, SessionEvent } from '@eden/api'
/** Independent terminal view. Agent actions go through the supplied command callback. */
export class Terminal extends InputDrafts {
  private readonly entries: ScreenEntry[] = []
  private readonly sessions: ScreenSession[] = []
  private panelState: ScreenPanel | undefined
  private menuItems: ScreenMenuItem[] = []
  private origin = 'mon'
  private title = ''
  private sessionId: string | undefined
  private connected = false
  private busy = false
  private older = false
  private sidebarVisible = false
  private contextTokens: number | null | undefined
  private modelLabel = ''
  private modelAvailable = true
  private agentLabel = ''
  private authStage: NonNullable<ScreenState['authStage']> = 'local'
  private accountLabel = ''
  private authMessage = ''
  private readonly launchLocation = (() => {
    const cwd = process.cwd()
    const project = path.basename(cwd) === 'Server' ? path.dirname(cwd) : cwd
    const name = project.startsWith(`${homedir()}${path.sep}`) ? `~${project.slice(homedir().length)}` : project
    try {
      const head = readFileSync(path.join(project, '.git', 'HEAD'), 'utf8').trim()
      return displayText(`${name}${head.startsWith('ref: refs/heads/') ? `:${head.slice(16)}` : ''}`)
    } catch { return displayText(name) }
  })()
  private location = '工作区未读取'
  private showToolDetails = false
  private showTimestamps = false
  private permissions = 0
  private questions = 0
  private scroll = 0
  private slashSelected = 0
  private slashDismissed = false
  private inputLabel = '消息>'
  private readonly clock = new ReplyClock()
  private clockTimer: ReturnType<typeof setInterval> | undefined
  private pasting = false
  private paste = ''
  private started = false
  private closed = false
  private wasRaw = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastRows: string[] = []
  private transcript: ColoredLine[] = []
  private transcriptWidth = 0
  private transcriptDirty = true
  private viewportHeight = 12
  private readonly done: Promise<void>
  private finish!: () => void

  constructor(private readonly onLine: (line: string, submission?: InputSubmission) => void) {
    super()
    this.done = new Promise(resolve => { this.finish = resolve })
  }

  start(): Promise<void> {
    if (this.started || this.closed) return this.done
    this.wasRaw = process.stdin.isRaw ?? false
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    this.started = true
    try {
      process.stdin.resume()
      process.stdin.on('keypress', this.keypress)
      process.stdin.on('end', this.close)
      process.stdout.on('resize', this.resize)
      process.on('SIGTERM', this.close)
      process.on('SIGHUP', this.close)
      process.on('exit', this.restore)
      process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?25h\x1b[2J')
      this.renderNow()
    } catch (error) { this.restore(); throw error }
    return this.done
  }

  setWorld(origin: string): void { this.origin = origin; this.requestRender() }
  setConnected(connected: boolean): void {
    this.connected = connected; this.clock.connection(connected); this.updateClockTimer(); this.requestRender()
  }
  get isClosed(): boolean { return this.closed }
  get turnElapsedMs(): number | undefined { return this.clock.read().elapsedMs }
  setWorkspace(info: { path: string; status: string }): void {
    this.location = info.status === 'unselected' ? '未选择工作区' : info.path || '工作区未知'
    if (info.status !== 'ready' && info.status !== 'unselected') this.location += ` (${info.status})`
    this.requestRender()
  }
  setTiming(snapshot: ReplyTimerSnapshot): void { this.clock.restore(snapshot); this.updateClockTimer(); this.requestRender() }
  observeTurn(event: SessionEvent): void { this.clock.observe(event); this.updateClockTimer(); this.requestRender() }
  recoverSubmission(submission: InputSubmission, automatic: boolean, target?: string): void {
    const restored = this.recoverInput(submission, automatic && !this.inputLabel.startsWith('回答'), target)
    if (restored === undefined) return
    this.print('系统', restored ? '发送失败，输入已恢复；请检查原因后再发送' : '输入已保留；查看历史确认执行结果后，可用 /restore 恢复')
  }
  restoreDraft(): void { this.restoreFailedInput(); this.requestRender() }
  clearAccount(): void { this.clearInputDrafts(); this.clock.reset(); this.location = '工作区未读取'; this.updateClockTimer(); this.home() }
  setBusy(busy: boolean): void { this.busy = busy; this.requestRender() }
  setOlder(older: boolean): void { this.older = older; this.transcriptDirty = true; this.requestRender() }
  setPending(permissions: number, questions: number): void {
    this.permissions = permissions; this.questions = questions; this.requestRender()
  }
  setSessions(items: ScreenSession[]): void {
    this.sessions.splice(0, this.sessions.length, ...items.map(item => ({ ...item, title: displayText(item.title) })))
    this.requestRender()
  }
  setSession(id: string, title: string, busy: boolean, contextTokens?: number | null): void {
    if (this.sessionId !== id) {
      this.selectDraft(id)
      this.clock.reset(); this.updateClockTimer()
      this.modelLabel = ''
      this.location = '工作区未读取'
    }
    this.sessionId = id; this.title = displayText(title); this.busy = busy; this.contextTokens = contextTokens; this.requestRender()
  }
  setModel(label: string, available: boolean): void {
    this.modelLabel = displayText(label); this.modelAvailable = available; this.requestRender()
  }
  setDraft(value: string): void {
    if (this.input) return
    this.input = value; this.cursor = graphemes(value).length; this.requestRender()
    this.inputEdited()
  }
  setAgent(label: string): void { this.agentLabel = displayText(label); this.requestRender() }
  setAuth(stage: NonNullable<ScreenState['authStage']>, account = '', message = ''): void {
    this.authStage = stage; this.accountLabel = displayText(account); this.authMessage = displayText(message)
    this.requestRender()
  }
  setInputMode(mode: 'normal' | 'username' | 'password'): void {
    if (mode === 'normal' && this.inputMode === 'normal') return
    this.changeInputMode(mode)
    this.slashDismissed = false; this.slashSelected = 0
    this.inputLabel = mode === 'username' ? 'Core 用户名>' : mode === 'password' ? 'Core 密码>' : '消息>'
    this.requestRender()
  }
  home(): void {
    this.selectDraft(undefined)
    this.clock.reset(); this.updateClockTimer()
    this.sessionId = undefined; this.title = ''; this.contextTokens = undefined
    this.location = `启动目录 ${this.launchLocation}`
    this.modelLabel = ''; this.agentLabel = ''; this.busy = false; this.older = false
    this.entries.length = 0; this.scroll = 0
    this.historyIndex = -1; this.inputLabel = '消息>'; this.panelState = undefined
    this.slashDismissed = false; this.slashSelected = 0
    this.transcriptDirty = true; this.requestRender()
  }
  toggleSidebar(): boolean { this.sidebarVisible = !this.sidebarVisible; this.transcriptDirty = true; this.requestRender(); return this.sidebarVisible }
  clearTranscript(): void {
    this.entries.length = 0; this.scroll = 0; this.transcriptDirty = true; this.requestRender()
  }
  print(label: string, value: unknown): void { this.upsert(undefined, label, value) }
  upsert(key: string | undefined, label: string, value: unknown, complete = true, time?: number, failed = false): void {
    const previousLength = this.scroll ? this.projectedLength() : 0
    const entry: ScreenEntry = { ...(key ? { key } : {}), label: displayText(label), text: displayText(value),
      complete, failed, ...(time === undefined ? {} : { time }) }
    const index = key ? this.entries.findIndex(item => item.key === key) : -1
    if (index < 0) this.entries.push(entry)
    else this.entries[index] = entry
    if (this.scroll) this.scroll = Math.max(0, this.scroll + this.projectedLength() - previousLength)
    this.transcriptDirty = true
    this.requestRender()
  }

  private projectedLength(): number {
    return transcriptLines(this.entries, this.transcriptWidth || 80, this.older,
      { details: this.showToolDetails, timestamps: this.showTimestamps }).length
  }
  prepend(items: ScreenEntry[]): void {
    if (!items.length) return
    this.entries.unshift(...items.map(item => ({ ...item, label: displayText(item.label), text: displayText(item.text) })))
    this.scroll = Math.max(0, this.projectedLength() - this.viewportHeight)
    this.transcriptDirty = true
    this.requestRender()
  }
  prompt(text: string): void {
    if (text.startsWith('回答') && !this.inputLabel.startsWith('回答')) {
      this.savedDraft = this.input; this.input = ''; this.cursor = 0
    } else if (!text.startsWith('回答') && this.inputLabel.startsWith('回答')) {
      this.input = this.savedDraft; this.cursor = graphemes(this.input).length; this.savedDraft = ''
    }
    this.inputLabel = displayText(text.trim())
    this.requestRender()
  }
  showMenu(title: string, items: ScreenMenuItem[], lines: string[] = [], searchable = false): void {
    this.menuItems = items.map(item => ({ ...item, label: displayText(item.label),
      ...(item.detail ? { detail: displayText(item.detail) } : {}) }))
    this.panelState = { title: displayText(title), lines: lines.map(displayText),
      items: this.menuItems, selected: 0, searchable, query: '' }
    this.requestRender()
  }
  showPanel(title: string, lines: string[]): void {
    this.menuItems = []
    this.panelState = { title: displayText(title), lines: lines.map(displayText), selected: 0 }
    this.requestRender()
  }
  hidePanel(): void { this.panelState = undefined; this.menuItems = []; this.requestRender() }
  toggleDetails(): boolean { this.showToolDetails = !this.showToolDetails; this.transcriptDirty = true; this.requestRender(); return this.showToolDetails }
  toggleTimestamps(): boolean { this.showTimestamps = !this.showTimestamps; this.transcriptDirty = true; this.requestRender(); return this.showTimestamps }

  showTimeline(): void {
    const items = this.entries.filter(entry => entry.key?.startsWith('message:')).slice(-100).map(entry => ({
      label: `${entry.label} · ${displayText(entry.text.split('\n')[0]).slice(0, 72)}`,
      detail: entry.time ? new Date(entry.time).toLocaleString('zh-CN') : '',
      command: `/jump ${entry.key}`,
    }))
    if (!items.length) { this.print('系统', '当前没有可跳转的消息'); return }
    this.showMenu('消息时间线', items, [], true)
  }

  jumpTo(key: string): void {
    const index = this.entries.findIndex(entry => entry.key === key)
    if (index < 0) throw new Error('消息已不在当前视图中')
    const options = { details: this.showToolDetails, timestamps: this.showTimestamps }
    const width = this.transcriptWidth || 80
    const top = transcriptLines(this.entries.slice(0, index), width, this.older, options).length
    const total = transcriptLines(this.entries, width, this.older, options).length
    this.scroll = Math.max(0, total - this.viewportHeight - top)
    this.requestRender()
  }

  private filterMenu(query: string): void {
    if (!this.panelState?.searchable) return
    this.panelState.query = query
    this.panelState.items = searchMenu(this.menuItems, query)
    this.panelState.selected = 0
    this.requestRender()
  }

  private activeSlash(): SlashCommand[] {
    return this.inputMode === 'normal' && !this.inputLabel.startsWith('回答') && !this.slashDismissed
      && !this.panelState ? slashMatches(this.input) : []
  }

  private chooseSlash(item: SlashCommand, execute: boolean): void {
    this.slashDismissed = true
    this.slashSelected = 0
    if (execute && !item.argument) {
      this.input = ''; this.cursor = 0
      this.onLine(item.command)
    } else {
      this.input = `${item.command}${item.argument ? ' ' : ''}`
      this.cursor = graphemes(this.input).length
    }
    this.requestRender()
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.restore()
    this.finish()
  }

  private restore = (): void => {
    if (!this.started) return
    this.started = false
    process.stdin.off('keypress', this.keypress)
    process.stdin.off('end', this.close)
    process.stdout.off('resize', this.resize)
    process.off('SIGTERM', this.close)
    process.off('SIGHUP', this.close)
    process.off('exit', this.restore)
    try { process.stdin.setRawMode(this.wasRaw) } catch { /* terminal may already be gone */ }
    process.stdin.pause()
    try { process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l') } catch { /* terminal may already be gone */ }
  }

  private resize = (): void => {
    this.lastRows = []
    this.transcriptDirty = true
    process.stdout.write('\x1b[2J')
    this.requestRender()
  }

  private requestRender(): void {
    if (!this.started || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.renderNow() }, 16)
  }

  private updateClockTimer(): void {
    const animate = this.started && this.connected && this.clock.running
    if (animate && !this.clockTimer) this.clockTimer = setInterval(() => this.requestRender(), 1000)
    if (!animate && this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = undefined }
  }

  private renderNow(): void {
    if (!this.started) return
    const width = process.stdout.columns || 80
    const height = process.stdout.rows || 24
    const mainWidth = contentWidth(width, this.sidebarVisible)
    if (this.transcriptDirty || this.transcriptWidth !== mainWidth) {
      this.transcript = transcriptLines(this.entries, mainWidth, this.older,
        { details: this.showToolDetails, timestamps: this.showTimestamps })
      this.transcriptWidth = mainWidth
      this.transcriptDirty = false
    }
    const slash = this.activeSlash()
    const state = this.screenState(width, height, slash)
    const frame = renderFrame(state, this.transcript, !process.env.NO_COLOR)
    this.viewportHeight = frame.transcriptHeight
    let output = '\x1b[?2026h'
    frame.lines.forEach((row, index) => {
      if (row !== this.lastRows[index]) output += `\x1b[${index + 1};1H\x1b[2K${row}`
    })
    output += `\x1b[${frame.cursorRow};${frame.cursorColumn}H\x1b[?2026l`
    this.lastRows = frame.lines
    process.stdout.write(output)
  }

  private screenState(width: number, height: number, slash: ScreenMenuItem[]): ScreenState {
    const timing = this.clock.read()
    return { width, height, origin: this.origin, connected: this.connected, busy: this.busy,
      title: this.title, ...(this.sessionId ? { sessionId: this.sessionId } : {}), sessions: this.sessions,
      entries: this.entries, scroll: this.scroll, older: this.older, permissions: this.permissions,
      questions: this.questions, input: this.inputMode === 'password' ? '•'.repeat(graphemes(this.input).length) : this.input,
      inputCursor: this.cursor, inputLabel: this.inputLabel,
      sidebarVisible: this.sidebarVisible,
      turnPhase: timing.phase, ...(timing.elapsedMs === undefined ? {} : { turnElapsedMs: timing.elapsedMs }),
      ...(this.contextTokens === undefined ? {} : { contextTokens: this.contextTokens }),
      ...(this.modelLabel ? { modelLabel: this.modelLabel, modelAvailable: this.modelAvailable } : {}),
      ...(this.agentLabel ? { agentLabel: this.agentLabel } : {}), location: this.location,
      authStage: this.authStage,
      ...(this.accountLabel ? { accountLabel: this.accountLabel } : {}),
      ...(this.authMessage ? { authMessage: this.authMessage } : {}),
      ...(this.panelState ? { panel: this.panelState } : {}),
      ...(slash.length ? { slashSuggestions: { items: slash, selected: this.slashSelected } } : {}) }
  }

  private insert(value: string): void {
    if (!this.insertInput(value)) return
    if (this.panelState && !this.panelState.items) this.hidePanel()
    this.slashDismissed = false; this.slashSelected = 0
    this.requestRender()
  }

  private submit(): void {
    const input = this.takeInput(this.inputLabel.startsWith('回答'))
    if (!input) return
    this.slashDismissed = false; this.slashSelected = 0
    this.onLine(input.value, input.submission)
    this.requestRender()
  }

  private keypress = (text: string | undefined, key: KeyPress = {}): void => {
    try { this.handleKey(text, key) }
    catch (error) { this.print('错误', error instanceof Error ? error.message : String(error)) }
  }

  private pasteKey(text: string | undefined, key: KeyPress): boolean {
    if (key.name === 'paste-start') { this.pasting = true; this.paste = ''; return true }
    if (key.name === 'paste-end') {
      this.pasting = false
      if (this.panelState?.searchable) this.filterMenu(`${this.panelState.query ?? ''}${displayText(this.paste)}`)
      else this.insert(this.paste)
      this.paste = ''
      return true
    }
    if (this.pasting) { this.paste += isEnter(key) ? '\n' : text ?? ''; return true }
    return false
  }

  private menuKey(text: string | undefined, key: KeyPress): void {
    const panel = this.panelState!
    const items = panel.items!
      if (key.name === 'escape') { this.hidePanel(); return }
      if (isVertical(key)) {
        panel.selected = Math.max(0, Math.min(items.length - 1,
          panel.selected + (key.name === 'up' ? -1 : 1)))
        this.requestRender(); return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const command = items[panel.selected]?.command
        if (command) { this.hidePanel(); this.onLine(command) }
        return
      }
      if (panel.searchable) { this.searchKey(text, key); return }
      if (text && /^[1-9]$/.test(text)) {
        const command = items[Number(text) - 1]?.command
        if (command) { this.hidePanel(); this.onLine(command) }
      }
      return
  }

  private searchKey(text: string | undefined, key: KeyPress): void {
    const panel = this.panelState!
        if (key.name === 'backspace') this.filterMenu(graphemes(panel.query ?? '').slice(0, -1).join(''))
        else if (key.ctrl && key.name === 'u') this.filterMenu('')
        else if (!key.ctrl && !key.meta && text && text >= ' ') this.filterMenu(`${panel.query ?? ''}${displayText(text)}`)
  }

  private escapeKey(): void {
      if (this.inputMode === 'password') { this.input = ''; this.cursor = 0; this.onLine('/login-back'); return }
      if (this.inputLabel.startsWith('回答')) this.onLine('/back')
      else if (this.panelState) this.hidePanel()
      else if (this.activeSlash().length) { this.slashDismissed = true; this.requestRender() }
  }

  private enterKey(key: KeyPress): void {
      if (this.inputMode === 'normal' && (key.meta || key.shift)) this.insert('\n')
      else {
        const matches = this.activeSlash()
        const selected = matches[this.slashSelected] ?? matches[0]
        if (selected && (selected.command !== this.input || selected.argument)) this.chooseSlash(selected, true)
        else this.submit()
      }
  }

  private slashKey(key: KeyPress): boolean {
    const matches = this.activeSlash()
    if ((key.name === 'up' || key.name === 'down') && matches.length) {
      this.slashSelected = Math.max(0, Math.min(matches.length - 1,
        this.slashSelected + (key.name === 'up' ? -1 : 1)))
      this.requestRender(); return true
    }
    if (key.name === 'tab' && matches.length) {
      this.chooseSlash(matches[this.slashSelected] ?? matches[0]!, false)
      return true
    }
    return false
  }

  private shortcutKey(text: string | undefined, key: KeyPress): boolean {
    const views: Record<string, () => void> = { b: () => { this.toggleSidebar() }, d: () => { this.toggleDetails() },
      t: () => this.showTimeline(), l: () => { this.scroll = 0 }, end: () => { this.scroll = 0 },
      home: () => { this.scroll = Math.max(0, this.transcript.length - this.viewportHeight) } }
    const view = key.ctrl ? views[key.name ?? ''] : undefined
    if (view) { view(); this.requestRender(); return true }
    const command = commandKey(text, key, this.inputLabel.startsWith('回答'))
    if (command) { this.onLine(command); return true }
    if (key.name === 'f1') return true
    if (!isPage(key)) return false
    this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? 1 : -1) * Math.max(1, this.viewportHeight - 2))
    this.requestRender()
    return true
  }

  private editorKey(text: string | undefined, key: KeyPress): void {
    const edit = editInput(this.input, this.cursor, key)
    if (edit) {
      this.input = edit.input; this.cursor = edit.cursor
      if (edit.changed) { this.inputEdited(); this.slashDismissed = false; this.slashSelected = 0 }
    } else if (isVertical(key) && this.inputMode === 'normal') {
      this.navigateHistory(key.name === 'up' ? -1 : 1); this.requestRender(); return
    } else if (isText(text, key)) this.insert(text)
    this.requestRender()
  }

  private handleKey(text: string | undefined, key: KeyPress): void {
    if (this.pasteKey(text, key)) return
    if (key.ctrl && key.name === 'c') { this.close(); return }
    if (this.panelState?.items) { this.menuKey(text, key); return }
    if (this.panelState && isPage(key)) {
      this.panelState.selected = Math.max(0, this.panelState.selected + (key.name === 'pageup' ? -3 : 3))
      this.requestRender(); return
    }
    if (key.name === 'escape') { this.escapeKey(); return }
    if (restrictedKey(key, this.inputMode, this.inputLabel.startsWith('回答'))) return
    if (this.shortcutKey(text, key)) return
    if (isEnter(key)) { this.enterKey(key); return }
    if (key.ctrl && key.name === 'j') { this.insert('\n'); return }
    if (this.slashKey(key)) return
    this.editorKey(text, key)
  }

}

export { displayText } from './screen-text.ts'
