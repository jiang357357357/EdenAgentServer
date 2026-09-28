import { emitKeypressEvents } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { displayText, graphemes } from './screen-text.ts'
import { searchMenu } from './menu-search.ts'
import { slashMatches, type SlashCommand } from './slash-commands.ts'
import { contentWidth, renderFrame, transcriptLines } from './terminal-frame.ts'
import type { ColoredLine, ScreenEntry, ScreenMenuItem, ScreenPanel, ScreenSession, ScreenState } from './terminal-frame.ts'

interface KeyPress { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
/** Independent terminal view. Agent actions go through the supplied command callback. */
export class Terminal {
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
  private inputMode: 'normal' | 'username' | 'password' = 'normal'
  private readonly location = (() => {
    const cwd = process.cwd()
    const project = path.basename(cwd) === 'Server' ? path.dirname(cwd) : cwd
    const name = project.startsWith(`${homedir()}${path.sep}`) ? `~${project.slice(homedir().length)}` : project
    try {
      const head = readFileSync(path.join(project, '.git', 'HEAD'), 'utf8').trim()
      return displayText(`${name}${head.startsWith('ref: refs/heads/') ? `:${head.slice(16)}` : ''}`)
    } catch { return displayText(name) }
  })()
  private showToolDetails = false
  private showTimestamps = false
  private permissions = 0
  private questions = 0
  private scroll = 0
  private input = ''
  private cursor = 0
  private slashSelected = 0
  private slashDismissed = false
  private inputLabel = '消息>'
  private savedDraft = ''
  private history: string[] = []
  private readonly drafts = new Map<string, { input: string; cursor: number; history: string[] }>()
  private historyIndex = -1
  private historyDraft = ''
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

  constructor(private readonly onLine: (line: string) => void) {
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
  setConnected(connected: boolean): void { this.connected = connected; this.requestRender() }
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
      if (this.sessionId) this.drafts.set(this.sessionId, { input: this.input, cursor: this.cursor, history: this.history })
      const draft = this.drafts.get(id)
      this.input = draft?.input ?? ''
      this.cursor = draft?.cursor ?? 0
      this.history = draft?.history ?? []
      this.historyIndex = -1
      this.modelLabel = ''
    }
    this.sessionId = id; this.title = displayText(title); this.busy = busy; this.contextTokens = contextTokens; this.requestRender()
  }
  setModel(label: string, available: boolean): void {
    this.modelLabel = displayText(label); this.modelAvailable = available; this.requestRender()
  }
  setDraft(value: string): void {
    if (this.input) return
    this.input = value; this.cursor = graphemes(value).length; this.requestRender()
  }
  setAgent(label: string): void { this.agentLabel = displayText(label); this.requestRender() }
  setAuth(stage: NonNullable<ScreenState['authStage']>, account = '', message = ''): void {
    this.authStage = stage; this.accountLabel = displayText(account); this.authMessage = displayText(message)
    this.requestRender()
  }
  setInputMode(mode: 'normal' | 'username' | 'password'): void {
    this.inputMode = mode; this.input = ''; this.cursor = 0
    this.slashDismissed = false; this.slashSelected = 0
    this.inputLabel = mode === 'username' ? 'Core 用户名>' : mode === 'password' ? 'Core 密码>' : '消息>'
    this.requestRender()
  }
  home(): void {
    if (this.sessionId) this.drafts.set(this.sessionId, { input: this.input, cursor: this.cursor, history: this.history })
    this.sessionId = undefined; this.title = ''; this.contextTokens = undefined
    this.modelLabel = ''; this.agentLabel = ''; this.busy = false; this.older = false
    this.entries.length = 0; this.scroll = 0; this.input = ''; this.cursor = 0; this.history = []
    this.historyIndex = -1; this.inputLabel = '消息>'; this.panelState = undefined
    this.slashDismissed = false; this.slashSelected = 0
    this.transcriptDirty = true; this.requestRender()
  }
  toggleSidebar(): boolean { this.sidebarVisible = !this.sidebarVisible; this.transcriptDirty = true; this.requestRender(); return this.sidebarVisible }
  clearTranscript(): void {
    this.entries.length = 0; this.scroll = 0; this.transcriptDirty = true; this.requestRender()
  }
  print(label: string, value: unknown): void { this.upsert(undefined, label, value) }
  upsert(key: string | undefined, label: string, value: unknown, complete = true, time?: number): void {
    const previousLength = this.scroll ? this.projectedLength() : 0
    const entry: ScreenEntry = { ...(key ? { key } : {}), label: displayText(label), text: displayText(value),
      complete, ...(time === undefined ? {} : { time }) }
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
    const state: ScreenState = { width, height, origin: this.origin, connected: this.connected, busy: this.busy,
      title: this.title, ...(this.sessionId ? { sessionId: this.sessionId } : {}), sessions: this.sessions,
      entries: this.entries, scroll: this.scroll, older: this.older, permissions: this.permissions,
      questions: this.questions, input: this.inputMode === 'password' ? '•'.repeat(graphemes(this.input).length) : this.input,
      inputCursor: this.cursor, inputLabel: this.inputLabel,
      sidebarVisible: this.sidebarVisible,
      ...(this.contextTokens === undefined ? {} : { contextTokens: this.contextTokens }),
      ...(this.modelLabel ? { modelLabel: this.modelLabel, modelAvailable: this.modelAvailable } : {}),
      ...(this.agentLabel ? { agentLabel: this.agentLabel } : {}), location: this.location,
      authStage: this.authStage,
      ...(this.accountLabel ? { accountLabel: this.accountLabel } : {}),
      ...(this.authMessage ? { authMessage: this.authMessage } : {}),
      ...(this.panelState ? { panel: this.panelState } : {}),
      ...(slash.length ? { slashSuggestions: { items: slash, selected: this.slashSelected } } : {}) }
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

  private insert(value: string): void {
    const clean = this.inputMode === 'password'
      ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, Math.max(0, 4096 - this.input.length)) : displayText(value)
    if (!clean) return
    if (this.panelState && !this.panelState.items) this.hidePanel()
    const points = graphemes(this.input)
    points.splice(this.cursor, 0, ...graphemes(clean))
    this.input = points.join('')
    this.cursor += graphemes(clean).length
    this.slashDismissed = false; this.slashSelected = 0
    this.requestRender()
  }

  private submit(): void {
    const value = this.inputMode === 'password' ? this.input : this.input.trim()
    if (!value && this.inputMode === 'normal') return
    this.input = ''; this.cursor = 0; this.historyIndex = -1
    this.slashDismissed = false; this.slashSelected = 0
    if (this.inputMode === 'normal' && !value.startsWith('/')) {
      this.history.push(value)
      if (this.history.length > 100) this.history.shift()
    }
    this.onLine(value)
    this.requestRender()
  }

  private keypress = (text: string | undefined, key: KeyPress = {}): void => {
    try { this.handleKey(text, key) }
    catch (error) { this.print('错误', error instanceof Error ? error.message : String(error)) }
  }

  private handleKey(text: string | undefined, key: KeyPress): void {
    if (key.name === 'paste-start') { this.pasting = true; this.paste = ''; return }
    if (key.name === 'paste-end') {
      this.pasting = false
      if (this.panelState?.searchable) this.filterMenu(`${this.panelState.query ?? ''}${displayText(this.paste)}`)
      else this.insert(this.paste)
      this.paste = ''
      return
    }
    if (this.pasting) { this.paste += key.name === 'return' || key.name === 'enter' ? '\n' : text ?? ''; return }
    if (key.ctrl && key.name === 'c') { this.close(); return }
    if (this.panelState?.items) {
      const items = this.panelState.items
      if (key.name === 'escape') { this.hidePanel(); return }
      if (key.name === 'up' || key.name === 'down') {
        this.panelState.selected = Math.max(0, Math.min(items.length - 1,
          this.panelState.selected + (key.name === 'up' ? -1 : 1)))
        this.requestRender(); return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const command = items[this.panelState.selected]?.command
        if (command) { this.hidePanel(); this.onLine(command) }
        return
      }
      if (this.panelState.searchable) {
        if (key.name === 'backspace') this.filterMenu(graphemes(this.panelState.query ?? '').slice(0, -1).join(''))
        else if (key.ctrl && key.name === 'u') this.filterMenu('')
        else if (!key.ctrl && !key.meta && text && text >= ' ') this.filterMenu(`${this.panelState.query ?? ''}${displayText(text)}`)
        return
      }
      if (text && /^[1-9]$/.test(text)) {
        const command = items[Number(text) - 1]?.command
        if (command) { this.hidePanel(); this.onLine(command) }
      }
      return
    }
    if (this.panelState && (key.name === 'pageup' || key.name === 'pagedown')) {
      this.panelState.selected = Math.max(0, this.panelState.selected + (key.name === 'pageup' ? -3 : 3))
      this.requestRender(); return
    }
    if (key.name === 'escape') {
      if (this.inputMode === 'password') { this.input = ''; this.cursor = 0; this.onLine('/login-back'); return }
      if (this.inputLabel.startsWith('回答')) this.onLine('/back')
      else if (this.panelState) this.hidePanel()
      else if (this.activeSlash().length) { this.slashDismissed = true; this.requestRender() }
      return
    }
    if (this.inputMode !== 'normal' && (key.ctrl || key.meta) && !['a', 'e', 'u'].includes(key.name ?? '')) return
    if (this.inputLabel.startsWith('回答') && key.ctrl && ['p', 's', 'n', 'x', 'b', 't'].includes(key.name ?? '')) return
    if (key.ctrl && key.name === 'b') { this.toggleSidebar(); return }
    if (key.ctrl && key.name === 'd') { this.toggleDetails(); return }
    if (key.ctrl && key.name === 't') { this.showTimeline(); return }
    if (key.ctrl && key.name === 'l') { this.scroll = 0; this.requestRender(); return }
    if (key.ctrl && key.name === 'home') { this.scroll = Math.max(0, this.transcript.length - this.viewportHeight); this.requestRender(); return }
    if (key.ctrl && key.name === 'end') { this.scroll = 0; this.requestRender(); return }
    if (key.meta && text && /^[1-9]$/.test(text)) { this.onLine(`/use ${text}`); return }
    if (key.ctrl && key.name === 'p') { this.onLine('/menu'); return }
    if (key.ctrl && key.name === 's') { this.onLine('/sessions'); return }
    if (key.ctrl && key.name === 'n') { this.onLine('/new'); return }
    if (key.ctrl && key.name === 'x') { this.onLine('/stop'); return }
    if (key.name === 'f1') { if (!this.inputLabel.startsWith('回答')) this.onLine('/help'); return }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? 1 : -1) * Math.max(1, this.viewportHeight - 2))
      this.requestRender(); return
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (this.inputMode === 'normal' && (key.meta || key.shift)) this.insert('\n')
      else {
        const matches = this.activeSlash()
        const selected = matches[this.slashSelected] ?? matches[0]
        if (selected && (selected.command !== this.input || selected.argument)) this.chooseSlash(selected, true)
        else this.submit()
      }
      return
    }
    if (key.ctrl && key.name === 'j') { this.insert('\n'); return }
    const matches = this.activeSlash()
    if ((key.name === 'up' || key.name === 'down') && matches.length) {
      this.slashSelected = Math.max(0, Math.min(matches.length - 1,
        this.slashSelected + (key.name === 'up' ? -1 : 1)))
      this.requestRender(); return
    }
    if (key.name === 'tab' && matches.length) {
      this.chooseSlash(matches[this.slashSelected] ?? matches[0]!, false)
      return
    }
    const points = graphemes(this.input)
    if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1)
    else if (key.name === 'right') this.cursor = Math.min(points.length, this.cursor + 1)
    else if (key.name === 'home' || key.ctrl && key.name === 'a') this.cursor = 0
    else if (key.name === 'end' || key.ctrl && key.name === 'e') this.cursor = points.length
    else if (key.name === 'backspace' && this.cursor) { points.splice(--this.cursor, 1); this.input = points.join(''); this.slashDismissed = false; this.slashSelected = 0 }
    else if (key.name === 'delete' && this.cursor < points.length) { points.splice(this.cursor, 1); this.input = points.join(''); this.slashDismissed = false; this.slashSelected = 0 }
    else if (key.ctrl && key.name === 'u') { this.input = ''; this.cursor = 0; this.slashDismissed = false; this.slashSelected = 0 }
    else if ((key.name === 'up' || key.name === 'down') && this.inputMode === 'normal') {
      this.navigateHistory(key.name === 'up' ? -1 : 1); return
    }
    else if (!key.ctrl && !key.meta && text && text >= ' ') this.insert(text)
    this.requestRender()
  }

  private navigateHistory(direction: -1 | 1): void {
    if (!this.history.length) return
    if (this.historyIndex < 0) { this.historyDraft = this.input; this.historyIndex = this.history.length }
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction))
    this.input = this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex] ?? ''
    this.cursor = graphemes(this.input).length
    this.requestRender()
  }
}

export { displayText } from './screen-text.ts'
