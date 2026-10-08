import { cells, clip, fit, graphemes, wrap } from './screen-text.ts'
import { renderHomeFrame } from './home-frame.ts'
import { panelLines } from './panel-frame.ts'
import { style } from './terminal-style.ts'
import type { ColoredLine, Frame, ScreenState } from './screen-state.ts'
export type { ColoredLine, Frame, ScreenEntry, ScreenSession, ScreenMenuItem, ScreenPanel, ScreenSuggestions, ScreenState } from './screen-state.ts'
export { transcriptLines } from './transcript-view.ts'

export function sidebarWidth(width: number, visible: boolean): number {
  return visible && width >= 110 ? Math.min(30, Math.floor(width * 0.25)) : 0
}

export function contentWidth(width: number, sidebarVisible: boolean): number {
  const side = sidebarWidth(width, sidebarVisible)
  return Math.max(1, Math.min(96, width - side - (side ? 2 : 0) - 4))
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

type ConversationLayout = { width: number; height: number; sideWidth: number; mainArea: number; mainWidth: number; startColumn: number; editorRows: number; panelHeight: number; bodyHeight: number; offset: number; start: number }
type MainRow = (line: ColoredLine) => string
type FullRow = (value: string) => string

function conversationLayout(state: ScreenState, transcript: ColoredLine[]): ConversationLayout {
  const width = Math.max(1, state.width), height = Math.max(1, state.height)
  const sideWidth = sidebarWidth(width, state.sidebarVisible)
  const mainArea = width - sideWidth - (sideWidth ? 2 : 0)
  const mainWidth = contentWidth(width, state.sidebarVisible)
  const startColumn = Math.max(0, Math.floor((mainArea - mainWidth) / 2))
  const editorRows = height < 16 ? 1 : 3
  const available = height - 5 - editorRows
  const panelHeight = state.panel ? Math.min(12, Math.max(2, Math.floor(available / 2))) : 0
  const bodyHeight = Math.max(2, available - panelHeight)
  const maxScroll = Math.max(0, transcript.length - bodyHeight)
  const offset = Math.min(state.scroll, maxScroll)
  const start = Math.max(0, transcript.length - bodyHeight - offset)
  return { width, height, sideWidth, mainArea, mainWidth, startColumn, editorRows, panelHeight, bodyHeight, offset, start }
}

function transcriptBody(state: ScreenState, transcript: ColoredLine[], bodyHeight: number, start: number): ColoredLine[] {
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
  return body
}

function conversationBody(rows: string[], state: ScreenState, transcript: ColoredLine[], layout: ConversationLayout, main: MainRow, color: boolean): void {
  const { width, sideWidth, mainArea, mainWidth, startColumn, panelHeight, bodyHeight, start } = layout
  const body = transcriptBody(state, transcript, bodyHeight, start)
  const aside = sideWidth ? sidebar(state, bodyHeight, sideWidth) : []
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
}

function statusRows(rows: string[], state: ScreenState, layout: ConversationLayout, main: MainRow): void {
  const { width, offset } = layout
  const warnings = [!state.connected ? '● 已断开' : state.busy ? '● 正在处理' : '',
    state.modelAvailable === false ? '◇ 未选择模型 · /models' : '',
    state.permissions ? `审批 ${state.permissions}` : '', state.questions ? `提问 ${state.questions}` : '',
    offset ? `上移 ${offset} 行` : ''].filter(Boolean).join('  ·  ')
  rows.push(main({ text: warnings, kind: warnings ? 'warning' : 'muted' }))
  rows.push(fit('', width))
}

function editorRows(rows: string[], state: ScreenState, layout: ConversationLayout, full: FullRow, color: boolean): { cursorRow: number; cursorColumn: number; editorStartRow: number } {
  const { width, height, mainWidth, startColumn, editorRows } = layout
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
  return { cursorRow: Math.min(height, editorStartRow + cursorLine - editStart), cursorColumn: Math.min(width, startColumn + 3 + cells(before.at(-1) ?? '')), editorStartRow }
}

function footerRow(state: ScreenState, mainWidth: number): ColoredLine {
  const model = state.modelAvailable === false ? state.agentLabel || state.origin.toUpperCase()
    : state.modelLabel || state.agentLabel || state.origin.toUpperCase()
  const shortcuts = mainWidth >= 58 ? '/ 命令 · Ctrl+P 搜索 · Ctrl+S 会话' : '/ 命令 · Ctrl+P 搜索'
  const modelName = clip(model, Math.max(1, mainWidth - cells(shortcuts) - 2))
  const footer = `${modelName}${' '.repeat(Math.max(2, mainWidth - cells(modelName) - cells(shortcuts)))}${shortcuts}`
  return { text: footer, kind: 'muted' }
}

function slashRows(rows: string[], state: ScreenState, bodyHeight: number, editorStartRow: number, main: MainRow): void {
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
}

export function renderFrame(state: ScreenState, transcript: ColoredLine[], color = true): Frame {
  const width = Math.max(1, state.width), height = Math.max(1, state.height)
  if (width < 30 || height < 10) return {
    lines: Array.from({ length: height }, (_, index) => fit(index === 0 ? '终端窗口太小，请放大' : '', width)),
    cursorRow: 1, cursorColumn: 1, transcriptHeight: 1,
  }
  if (!state.sessionId && width >= 45 && height >= 14) return renderHomeFrame(state, color)
  const layout = conversationLayout(state, transcript)
  const { mainWidth, startColumn } = layout
  const full = (value: string): string => ' '.repeat(startColumn) + value + ' '.repeat(Math.max(0, width - startColumn - mainWidth))
  const main: MainRow = line => full(style(line, mainWidth, color))
  const rows: string[] = []
  conversationBody(rows, state, transcript, layout, main, color)
  statusRows(rows, state, layout, main)
  const { cursorRow, cursorColumn, editorStartRow } = editorRows(rows, state, layout, full, color)
  rows.push(main(footerRow(state, mainWidth)))
  slashRows(rows, state, layout.bodyHeight, editorStartRow, main)
  return { lines: rows.slice(0, height), cursorRow, cursorColumn, transcriptHeight: layout.bodyHeight }
}
