import { cells, clip, fit, graphemes, wrap } from './screen-text.ts'
import { panelLines } from './panel-frame.ts'
import { serverVersion } from '../src/version.ts'
import { edenWordmarkHeight, edenWordmarkRow, edenWordmarkWidth } from './eden-wordmark.ts'
import type { ColoredLine, Frame, ScreenState } from './terminal-frame.ts'

function centered(value: string, width: number, color: boolean, tone = '148;148;148'): string {
  const start = Math.max(0, Math.floor((width - cells(value)) / 2))
  const content = clip(value, width - start)
  const plain = `${' '.repeat(start)}${content}${' '.repeat(Math.max(0, width - start - cells(content)))}`
  return color ? `${' '.repeat(start)}\x1b[38;2;${tone}m${content}\x1b[0m${' '.repeat(Math.max(0, width - start - cells(content)))}` : plain
}

function inputRow(value: string, width: number, start: number, panelWidth: number, color: boolean, muted = false): string {
  const content = fit(value, panelWidth - 3)
  const right = ' '.repeat(Math.max(0, width - start - panelWidth))
  if (!color) return `${' '.repeat(start)}┃ ${content} ${right}`
  return `${' '.repeat(start)}\x1b[48;2;31;31;34m\x1b[38;2;108;163;249m┃\x1b[38;2;${muted ? '156;156;160' : '236;236;239'}m ${content} \x1b[0m${right}`
}

function modalRow(line: ColoredLine, width: number, start: number, modalWidth: number, color: boolean): string {
  const content = fit(line.text, modalWidth - 2)
  const right = ' '.repeat(Math.max(0, width - start - modalWidth))
  const tone = line.kind === 'accent' ? '250;178;131' : line.kind === 'muted' ? '150;150;154' : '235;235;238'
  return color ? `${' '.repeat(start)}\x1b[48;2;39;39;43m\x1b[38;2;${tone}m ${content} \x1b[0m${right}`
    : `${' '.repeat(start)} ${content} ${right}`
}

export function renderHomeFrame(state: ScreenState, color: boolean): Frame {
  const width = state.width, height = state.height
  const rows = Array.from({ length: height }, () => fit('', width))
  const compact = height < 24
  const logoTop = compact ? (height < 17 ? 1 : 2) : Math.max(2, Math.floor(height * 0.17))
  for (let index = 0; index < edenWordmarkHeight; index++) {
    const start = Math.max(0, Math.floor((width - edenWordmarkWidth) / 2))
    rows[logoTop + index] = `${' '.repeat(start)}${edenWordmarkRow(index, color)}${' '.repeat(Math.max(0, width - start - edenWordmarkWidth))}`
  }

  const panelWidth = Math.min(78, width - 6)
  const start = Math.floor((width - panelWidth) / 2)
  const editorRows = height >= 24 ? 5 : height >= 17 ? 3 : 1
  const logoGap = compact ? (height < 18 ? 1 : 2) : 3
  const panelTop = Math.max(logoTop + edenWordmarkHeight + logoGap,
    Math.min(height - editorRows - 4, Math.floor(height * (compact ? 0.4 : 0.43))))
  const editWidth = Math.max(1, panelWidth - 3)
  const lines = wrap(state.input, editWidth)
  const prefix = graphemes(state.input).slice(0, state.inputCursor).join('')
  const before = wrap(prefix, editWidth)
  const cursorLine = before.length - 1
  const editStart = Math.max(0, Math.min(cursorLine - editorRows + 1, lines.length - editorRows))
  const login = state.authStage === 'username' || state.authStage === 'password'
  const pending = state.authStage === 'connecting' || state.authStage === 'server_error'
  const placeholder = state.authStage === 'username' ? 'Core 用户名'
    : state.authStage === 'password' ? 'Core 密码（不回显）'
      : state.authStage === 'connecting' ? '正在连接…'
        : state.authStage === 'server_error' ? '输入 /retry 重连'
          : 'Ask anything... 输入消息，开始新会话'
  for (let index = 0; index < editorRows; index++) {
    const line = lines[editStart + index] ?? ''
    const shown = !state.input && index === 0 ? placeholder : line
    rows[panelTop + index] = inputRow(shown, width, start, panelWidth, color, !state.input && index === 0)
  }
  const agent = state.agentLabel || (state.origin === 'mon' ? '伊甸园' : '尘世')
  const model = state.modelAvailable === false ? '未选择模型 · /models' : state.modelLabel || '模型待选择'
  const modelInfo = login ? 'Mon Core 登录 · 密码不保存' : pending ? '等待连接' : `${agent}  ·  ${model}`
  const identity = clip(state.accountLabel || (state.connected ? '已连接' : '未连接'), Math.min(22, editWidth - 4))
  const left = clip(modelInfo, Math.max(1, editWidth - cells(identity) - 2))
  const detail = `${left}${' '.repeat(Math.max(2, editWidth - cells(left) - cells(identity)))}${identity}`
  rows[panelTop + editorRows] = inputRow(detail, width, start, panelWidth, color, true)
  const latestError = state.entries.filter(entry => entry.label === '错误').at(-1)?.text
  const notice = state.authMessage || latestError || ''
  if (notice) rows[panelTop + editorRows + 2] = centered(clip(notice.replace(/\n/g, ' '), panelWidth), width, color, '224;108;117')
  const hint = login ? 'Enter 继续   Esc 返回' : pending ? '/retry 重连   Ctrl+C 退出' : '输入 / 查看命令   Ctrl+P 搜索'
  rows[panelTop + editorRows + 3] = fit(`${' '.repeat(Math.max(0, start + panelWidth - cells(hint)))}${hint}`, width)

  if (height >= 28 && height - 4 > panelTop + editorRows + 3) {
    const tip = 'Ctrl+S 切换会话，Ctrl+P 打开命令面板'
    const tipStart = Math.max(0, start + 6)
    const text = `● Tip  ${tip}`
    const padding = ' '.repeat(Math.max(0, width - tipStart - cells(text)))
    rows[height - 4] = color ? `${' '.repeat(tipStart)}\x1b[38;2;250;178;131m● Tip\x1b[38;2;148;148;152m  ${tip}\x1b[0m${padding}`
      : fit(`${' '.repeat(tipStart)}${text}`, width)
  }

  const location = clip(state.location || 'Eden Agent', Math.max(1, width - 24))
  const right = `v${serverVersion}`
  const footer = `${location}${' '.repeat(Math.max(1, width - cells(location) - cells(right)))}${right}`
  rows[height - 1] = color ? `\x1b[38;2;128;128;132m${footer}\x1b[0m` : fit(footer, width)

  if (state.panel) {
    const modalWidth = Math.min(68, width - 8)
    const panel = panelLines(state.panel, modalWidth - 2, Math.min(13, height - 7))
    const modalTop = Math.max(2, Math.floor((height - panel.length - 2) / 2))
    const modalStart = Math.floor((width - modalWidth) / 2)
    rows[modalTop] = modalRow({ text: '', kind: 'normal' }, width, modalStart, modalWidth, color)
    for (let index = 0; index < panel.length; index++) rows[modalTop + 1 + index] = modalRow(panel[index]!, width, modalStart, modalWidth, color)
    rows[modalTop + panel.length + 1] = modalRow({ text: '', kind: 'normal' }, width, modalStart, modalWidth, color)
    return { lines: rows,
      cursorRow: state.panel.searchable ? modalTop + 3 : height,
      cursorColumn: state.panel.searchable ? Math.min(modalStart + modalWidth - 2, modalStart + 4 + cells(state.panel.query ?? '')) : 1,
      transcriptHeight: Math.max(1, height - panelTop - 11) }
  }
  if (state.slashSuggestions?.items.length) {
    const suggestions = state.slashSuggestions
    const top = panelTop + editorRows + 2
    const capacity = Math.max(0, Math.min(7, height - top - 1))
    if (capacity > 1) {
      const count = Math.min(capacity - 1, suggestions.items.length)
      const first = Math.min(Math.max(0, suggestions.selected - count + 1), suggestions.items.length - count)
      rows[top] = modalRow({ text: '/ 命令 · ↑↓ 选择 · Tab 补全 · Enter 执行', kind: 'muted' }, width, start, panelWidth, color)
      for (let index = 0; index < count; index++) {
        const item = suggestions.items[first + index]!
        rows[top + index + 1] = modalRow({ text: `${first + index === suggestions.selected ? '›' : ' '} ${item.label}  ${item.detail ?? ''}`,
          kind: first + index === suggestions.selected ? 'accent' : 'normal' }, width, start, panelWidth, color)
      }
    }
  }
  return { lines: rows, cursorRow: panelTop + 1 + cursorLine - editStart,
    cursorColumn: Math.min(width, start + 3 + cells(before.at(-1) ?? '')), transcriptHeight: Math.max(1, height - panelTop - 11) }
}
