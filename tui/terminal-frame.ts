import { cells, clip, fit, graphemes, wrap } from './screen-text.ts'
import { markdownLines } from './markdown-lines.ts'
import { renderHomeFrame } from './home-frame.ts'
import { panelLines } from './panel-frame.ts'
import type { SpanTone, StyledSpan } from './styled-text.ts'

export interface ScreenEntry { key?: string; label: string; text: string; complete?: boolean; time?: number }
export interface ScreenSession { id: string; title: string; busy: boolean }
export interface ScreenMenuItem { label: string; command: string; detail?: string }
export interface ScreenPanel { title: string; lines: string[]; items?: ScreenMenuItem[]; selected: number;
  searchable?: boolean; query?: string }
export interface ScreenSuggestions { items: ScreenMenuItem[]; selected: number }
export interface ScreenState {
  width: number; height: number; origin: string; connected: boolean; busy: boolean
  title: string; sessionId?: string; sessions: ScreenSession[]; entries: ScreenEntry[]
  scroll: number; older: boolean; permissions: number; questions: number
  input: string; inputCursor: number; inputLabel: string; panel?: ScreenPanel
  slashSuggestions?: ScreenSuggestions
  sidebarVisible: boolean; contextTokens?: number | null; modelLabel?: string; modelAvailable?: boolean
  agentLabel?: string; location?: string
  authStage?: 'username' | 'password' | 'connecting' | 'authenticated' | 'server_error' | 'local'
  accountLabel?: string; authMessage?: string
}
export interface Frame { lines: string[]; cursorRow: number; cursorColumn: number; transcriptHeight: number }

type ColoredLine = { text: string; kind: 'normal' | 'muted' | 'accent' | 'user' | 'userBody' | 'tool' | 'error' | 'warning' | 'code' | 'heading' | 'quote'; spans?: StyledSpan[] }
const colors: Record<ColoredLine['kind'], string> = {
  normal: '\x1b[38;2;238;238;238m', muted: '\x1b[38;2;128;128;128m', accent: '\x1b[38;2;250;178;131m',
  user: '\x1b[38;2;86;182;194m', userBody: '\x1b[38;2;238;238;238m', tool: '\x1b[38;2;159;159;159m',
  error: '\x1b[38;2;224;108;117m', warning: '\x1b[38;2;245;167;66m',
  code: '\x1b[38;2;213;218;222m', heading: '\x1b[38;2;157;124;216m', quote: '\x1b[38;2;229;192;123m',
}
const spanColors: Record<SpanTone, string> = {
  strong: '\x1b[38;2;221;192;255m', emphasis: '\x1b[38;2;223;203;248m',
  link: '\x1b[38;2;130;175;255m', inlineCode: '\x1b[38;2;155;220;171m',
  keyword: '\x1b[38;2;198;166;255m', string: '\x1b[38;2;159;217;161m',
  number: '\x1b[38;2;238;184;132m', comment: '\x1b[38;2;132;145;143m',
  function: '\x1b[38;2;136;194;255m', type: '\x1b[38;2;139;213;219m',
  attribute: '\x1b[38;2;240;194;140m', variable: '\x1b[38;2;221;209;240m',
  punctuation: '\x1b[38;2;173;177;188m', meta: '\x1b[38;2;191;171;232m',
}

export function sidebarWidth(width: number, visible: boolean): number {
  return visible && width >= 110 ? Math.min(30, Math.floor(width * 0.25)) : 0
}

export function contentWidth(width: number, sidebarVisible: boolean): number {
  const side = sidebarWidth(width, sidebarVisible)
  return Math.max(1, Math.min(96, width - side - (side ? 2 : 0) - 4))
}

function style(line: ColoredLine, width: number, color: boolean): string {
  if (!color) return fit(line.text, width)
  if (!line.spans) return `${line.kind === 'userBody' ? '\x1b[48;2;30;30;30m' : ''}${colors[line.kind]}${fit(line.text, width)}\x1b[0m`
  let output = ''
  let used = 0
  outer: for (const span of line.spans) {
    let text = ''
    for (const cluster of graphemes(span.text)) {
      const size = cells(cluster)
      if (used + size > width) break outer
      text += cluster
      used += size
    }
    if (!text) continue
    output += `\x1b[0m${span.tone ? spanColors[span.tone] : colors[line.kind]}`
    if (span.tone === 'inlineCode') output += '\x1b[48;2;41;42;47m'
    if (span.bold) output += '\x1b[1m'
    if (span.italic) output += '\x1b[3m'
    if (span.underline) output += '\x1b[4m'
    if (span.strike) output += '\x1b[9m'
    output += text
  }
  return `${output}\x1b[0m${' '.repeat(Math.max(0, width - used))}`
}

export function transcriptLines(entries: ScreenEntry[], width: number, older: boolean,
  options: { details?: boolean; timestamps?: boolean } = {}): ColoredLine[] {
  const lines: ColoredLine[] = []
  if (older) lines.push({ text: '↑ 还有更早的消息 · 输入 /older 加载', kind: 'muted' })
  for (const entry of entries) {
    const time = options.timestamps && entry.time ? `  ${new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''
    if (entry.label === '系统' || entry.label === '帮助') {
      for (const row of wrap(entry.text, Math.max(1, width - 3))) lines.push({ text: `  · ${row}`, kind: 'muted' })
      continue
    }
    if (entry.label === '工具') {
      const [summary, ...details] = entry.text.split('\n')
      lines.push({ text: `  ${entry.complete === false ? '◌' : '◇'} ${summary}${time}`, kind: 'tool' })
      if (options.details) for (const row of wrap(details.join('\n'), Math.max(1, width - 5))) {
        if (row) lines.push({ text: `      ${row}`, kind: 'code' })
      }
      continue
    }
    if (entry.label === '审批' || entry.label === '提问' || entry.label === '错误') {
      const kind = entry.label === '错误' ? 'error' : 'warning'
      for (const row of wrap(entry.text, Math.max(1, width - 3))) lines.push({ text: `  ! ${row}`, kind })
      continue
    }
    const user = entry.label === '你'
    lines.push({ text: `  ${user ? '╭─ 你' : `◆ ${entry.label}`}${entry.complete === false ? '  ◌ 正在生成' : ''}${time}`, kind: user ? 'user' : 'accent' })
    if (user) for (const row of wrap(entry.text, Math.max(1, width - 4))) lines.push({ text: `  │ ${row}`, kind: 'userBody' })
    else lines.push(...markdownLines(entry.text, width))
    lines.push({ text: '', kind: 'normal' })
  }
  if (!lines.length) lines.push({ text: '输入消息开始对话；Ctrl+P 打开命令面板', kind: 'muted' })
  return lines
}

function sidebar(state: ScreenState, height: number, width: number): ColoredLine[] {
  const lines: ColoredLine[] = [
    { text: '  近期会话', kind: 'accent' }, { text: '', kind: 'normal' },
  ]
  const active = state.sessions.findIndex(item => item.id === state.sessionId)
  const available = Math.max(0, height - 5)
  const start = Math.min(Math.max(0, active - Math.floor(available / 2)), Math.max(0, state.sessions.length - available))
  for (const session of state.sessions.slice(start, start + available)) {
    const current = session.id === state.sessionId
    lines.push({ text: `  ${current ? '›' : ' '} ${session.busy ? '◉' : '·'} ${clip(session.title || '未命名', width - 7)}`,
      kind: current ? 'accent' : 'muted' })
  }
  while (lines.length < height - 2) lines.push({ text: '', kind: 'normal' })
  lines.push({ text: `  审批 ${state.permissions} · 提问 ${state.questions}`, kind: state.permissions || state.questions ? 'warning' : 'muted' })
  lines.push({ text: '  Ctrl+B 收起', kind: 'muted' })
  return lines.slice(0, height)
}

export function renderFrame(state: ScreenState, transcript: ColoredLine[], color = true): Frame {
  const width = Math.max(1, state.width), height = Math.max(1, state.height)
  if (width < 30 || height < 10) return {
    lines: Array.from({ length: height }, (_, index) => fit(index === 0 ? '终端窗口太小，请放大' : '', width)),
    cursorRow: 1, cursorColumn: 1, transcriptHeight: 1,
  }
  if (!state.sessionId && width >= 45 && height >= 14) return renderHomeFrame(state, color)
  const sideWidth = sidebarWidth(width, state.sidebarVisible)
  const mainArea = width - sideWidth - (sideWidth ? 2 : 0)
  const mainWidth = contentWidth(width, state.sidebarVisible)
  const startColumn = Math.max(0, Math.floor((mainArea - mainWidth) / 2))
  const full = (value: string): string => `${' '.repeat(startColumn)}${value}${' '.repeat(Math.max(0, width - startColumn - mainWidth))}`
  const main = (line: ColoredLine): string => full(style(line, mainWidth, color))
  const editorRows = height < 16 ? 1 : 3
  const available = height - 5 - editorRows
  const panelHeight = state.panel ? Math.min(12, Math.max(2, Math.floor(available / 2))) : 0
  const bodyHeight = Math.max(2, available - panelHeight)
  const maxScroll = Math.max(0, transcript.length - bodyHeight)
  const offset = Math.min(state.scroll, maxScroll)
  const start = Math.max(0, transcript.length - bodyHeight - offset)
  const home = !state.sessionId && !state.entries.some(entry => entry.label === '错误')
  const body = home ? Array.from({ length: bodyHeight }, (): ColoredLine => ({ text: '', kind: 'normal' }))
    : transcript.slice(start, start + bodyHeight)
  if (home) {
    const center = Math.max(0, Math.floor(bodyHeight / 2) - 1)
    body[center] = { text: 'EDEN', kind: 'accent' }
    const prompt = state.authStage === 'username' ? '输入 Core 用户名'
      : state.authStage === 'password' ? '输入 Core 密码'
        : state.authStage === 'connecting' ? '正在连接，请稍候'
          : state.authStage === 'server_error' ? '输入 /retry 重连'
            : '输入消息开始新会话'
    if (center + 2 < bodyHeight) body[center + 2] = { text: prompt, kind: 'muted' }
  }
  const aside = sideWidth ? sidebar(state, bodyHeight, sideWidth) : []
  const rows: string[] = []
  rows.push(main({ text: `EDEN  /  ${state.title || '新会话'}`, kind: 'accent' }))
  rows.push(fit('', width))
  for (let index = 0; index < bodyHeight; index++) {
    const content = `${' '.repeat(startColumn)}${style(body[index] ?? { text: '', kind: 'normal' }, mainWidth, color)}${' '.repeat(Math.max(0, mainArea - startColumn - mainWidth))}`
    rows.push(sideWidth ? `${content}${color ? '\x1b[38;2;72;72;72m' : ''}│ ${color ? '\x1b[0m' : ''}${style(aside[index] ?? { text: '', kind: 'normal' }, sideWidth, color)}` : content)
  }
  if (panelHeight) {
    const panel = panelLines(state.panel!, mainWidth, panelHeight)
    for (let index = 0; index < panelHeight; index++) {
      const row = panel[index] ?? { text: '', kind: 'normal' }
      rows.push(main(row))
    }
  }
  const warnings = [!state.connected ? '● 已断开' : state.busy ? '● 正在处理' : '',
    state.modelAvailable === false ? '◇ 未选择模型 · /models' : '',
    state.permissions ? `审批 ${state.permissions}` : '', state.questions ? `提问 ${state.questions}` : '',
    offset ? `上移 ${offset} 行` : ''].filter(Boolean).join('  ·  ')
  rows.push(main({ text: warnings, kind: warnings ? 'warning' : 'muted' }))
  rows.push(fit('', width))
  const editWidth = Math.max(1, mainWidth - 3)
  const inputLines = wrap(state.input, editWidth)
  const cursorPrefix = graphemes(state.input).slice(0, state.inputCursor).join('')
  const before = wrap(cursorPrefix, editWidth)
  const cursorLine = before.length - 1
  const editStart = Math.min(Math.max(0, cursorLine - editorRows + 1), Math.max(0, inputLines.length - editorRows))
  const editorStartRow = rows.length + 1
  for (let index = 0; index < editorRows; index++) {
    const input = inputLines[editStart + index] ?? ''
    const placeholder = !state.input && index === 0 ? state.authStage === 'username' ? 'Core 用户名'
      : state.authStage === 'password' ? 'Core 密码（不回显）' : '输入消息…' : ''
    const content = fit(input || placeholder, editWidth)
    const editor = color ? `\x1b[48;2;31;31;34m\x1b[38;2;108;163;249m┃\x1b[38;2;${placeholder ? '152;152;156' : '236;236;239'}m ${content} \x1b[0m`
      : `┃ ${content} `
    rows.push(full(editor))
  }
  const model = state.modelAvailable === false ? state.agentLabel || state.origin.toUpperCase()
    : state.modelLabel || state.agentLabel || state.origin.toUpperCase()
  const shortcuts = mainWidth >= 58 ? '/ 命令 · Ctrl+P 搜索 · Ctrl+S 会话' : '/ 命令 · Ctrl+P 搜索'
  const modelName = clip(model, Math.max(1, mainWidth - cells(shortcuts) - 2))
  const footer = `${modelName}${' '.repeat(Math.max(2, mainWidth - cells(modelName) - cells(shortcuts)))}${shortcuts}`
  rows.push(main({ text: footer, kind: 'muted' }))
  if (state.slashSuggestions?.items.length && !state.panel) {
    const suggestions = state.slashSuggestions
    const bottom = editorStartRow - 2
    const capacity = Math.min(5, Math.max(1, Math.floor(bodyHeight / 2)), bottom - 2)
    const count = Math.min(capacity, suggestions.items.length)
    const first = Math.min(Math.max(0, suggestions.selected - count + 1), suggestions.items.length - count)
    rows[bottom - count] = main({ text: '  / 命令 · ↑↓ 选择 · Tab 补全 · Enter 执行', kind: 'muted' })
    for (let index = 0; index < count; index++) {
      const item = suggestions.items[first + index]!
      rows[bottom - count + index + 1] = main({ text: `  ${first + index === suggestions.selected ? '›' : ' '} ${item.label}  ${item.detail ?? ''}`,
        kind: first + index === suggestions.selected ? 'accent' : 'normal' })
    }
  }
  return { lines: rows.slice(0, height), cursorRow: Math.min(height, editorStartRow + cursorLine - editStart),
    cursorColumn: Math.min(width, startColumn + 3 + cells(before.at(-1) ?? '')), transcriptHeight: bodyHeight }
}

export type { ColoredLine }
