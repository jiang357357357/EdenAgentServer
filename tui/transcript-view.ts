import { wrap } from './screen-text.ts'
import { markdownLines } from './markdown-lines.ts'
import type { ColoredLine, ScreenEntry } from './screen-state.ts'

type TranscriptOptions = { details?: boolean; timestamps?: boolean }

function toolLines(entry: ScreenEntry, width: number, time: string, detailsVisible = false): ColoredLine[] {
  const [summary, ...details] = entry.text.split('\n')
  const lines: ColoredLine[] = [{ text: `  ${entry.complete === false ? '◌' : '◇'} ${summary}${time}`, kind: 'tool' }]
  if (detailsVisible) for (const row of wrap(details.join('\n'), Math.max(1, width - 5))) {
    if (row) lines.push({ text: `      ${row}`, kind: 'code' })
  }
  return lines
}

function messageLines(entry: ScreenEntry, width: number, time: string): ColoredLine[] {
  const user = entry.label === '你'
  const lines: ColoredLine[] = [{ text: `  ${user ? '╭─ 你' : `◆ ${entry.label}`}${entry.complete === false ? '  ◌ 正在生成' : ''}${time}`, kind: user ? 'user' : 'accent' }]
  if (user) for (const row of wrap(entry.text, Math.max(1, width - 4))) lines.push({ text: `  │ ${row}`, kind: 'userBody' })
  else lines.push(...markdownLines(entry.text, width))
  lines.push({ text: '', kind: 'normal' })
  return lines
}

function entryLines(entry: ScreenEntry, width: number, options: TranscriptOptions): ColoredLine[] {
  const time = options.timestamps && entry.time ? `  ${new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''
  if (entry.label === '系统' || entry.label === '帮助') {
    return wrap(entry.text, Math.max(1, width - 3)).map(row => ({ text: `  · ${row}`, kind: 'muted' }))
  }
  if (entry.label === '工具') return toolLines(entry, width, time, options.details)
  if (['审批', '提问', '错误'].includes(entry.label)) {
    const kind = entry.label === '错误' ? 'error' : 'warning'
    return wrap(entry.text, Math.max(1, width - 3)).map(row => ({ text: `  ! ${row}`, kind }))
  }
  return messageLines(entry, width, time)
}

export function transcriptLines(entries: ScreenEntry[], width: number, older: boolean,
  options: TranscriptOptions = {}): ColoredLine[] {
  const lines: ColoredLine[] = []
  if (older) lines.push({ text: '↑ 还有更早的消息 · 输入 /older 加载', kind: 'muted' })
  for (const entry of entries) lines.push(...entryLines(entry, width, options))
  if (!lines.length) lines.push({ text: '输入消息开始对话；Ctrl+P 打开命令面板', kind: 'muted' })
  return lines
}
