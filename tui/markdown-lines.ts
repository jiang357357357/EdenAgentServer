import { cells, displayText } from './screen-text.ts'
import { codeSpans } from './code-highlight.ts'
import { inlineSpans } from './markdown-inline.ts'
import { splitStyledLines, wrapStyled, type StyledSpan } from './styled-text.ts'
import type { ColoredLine } from './terminal-frame.ts'

function wrapped(result: ColoredLine[], prefix: string, body: readonly StyledSpan[], width: number,
  kind: ColoredLine['kind']): void {
  for (const row of wrapStyled(body, Math.max(1, width - cells(prefix)))) {
    const spans = [{ text: prefix }, ...row]
    result.push({ text: spans.map(span => span.text).join(''), kind, spans })
  }
}

/** Project a streamed Markdown reply to terminal rows while retaining inline styles. */
export function markdownLines(source: string, width: number): ColoredLine[] {
  const result: ColoredLine[] = []
  const lines = displayText(source).split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = /^\s*(`{3,}|~{3,})\s*([^`~]*)$/.exec(line)
    if (fence) {
      const marker = fence[1]!
      const language = fence[2]!.trim().split(/\s+/)[0] ?? ''
      result.push({ text: `  ┌─ ${language || '代码'}`, kind: 'code' })
      const body: string[] = []
      const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
      while (index + 1 < lines.length && !closing.test(lines[index + 1]!)) body.push(lines[++index]!)
      const closed = index + 1 < lines.length
      for (const row of splitStyledLines(codeSpans(body.join('\n'), language))) {
        wrapped(result, '  │ ', row, width, 'code')
      }
      if (closed) { index++; result.push({ text: '  └─', kind: 'code' }) }
      continue
    }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line)
    if (heading) { wrapped(result, '  ▌ ', inlineSpans(heading[1]!), width, 'heading'); continue }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) { wrapped(result, '  │ ', inlineSpans(quote[1]!), width, 'quote'); continue }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      result.push({ text: `  ${'─'.repeat(Math.max(1, Math.min(40, width - 3)))}`, kind: 'muted' })
      continue
    }
    const list = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line)
    const body = list ? `${list[1]}${list[2] === '-' || list[2] === '*' ? '•' : list[2]} ${list[3]}` : line
    wrapped(result, '  ', inlineSpans(body), width, 'normal')
  }
  return result
}
