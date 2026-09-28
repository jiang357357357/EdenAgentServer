import { appendSpan, type StyledSpan } from './styled-text.ts'

const escaped = /[\\`*_{}\[\]()#+.!~>-]/
const markers = ['**', '__', '~~', '*', '_'] as const

/** Preserve readable source when a streamed Markdown marker has no closing pair yet. */
export function inlineSpans(source: string, depth = 0): StyledSpan[] {
  if (depth > 4) return [{ text: source }]
  const result: StyledSpan[] = []
  let plain = ''
  const flush = () => { appendSpan(result, { text: plain }); plain = '' }
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '\\' && index + 1 < source.length && escaped.test(source[index + 1]!)) {
      plain += source[index + 1]
      index += 2
      continue
    }
    if (char === '`') {
      const marker = /^`+/.exec(source.slice(index))![0]
      const close = source.indexOf(marker, index + marker.length)
      if (close > index + marker.length) {
        flush()
        appendSpan(result, { text: source.slice(index + marker.length, close), tone: 'inlineCode' })
        index = close + marker.length
        continue
      }
    }
    if (char === '[') {
      const labelEnd = source.indexOf(']', index + 1)
      if (labelEnd > index + 1 && source[labelEnd + 1] === '(') {
        const urlEnd = source.indexOf(')', labelEnd + 2)
        if (urlEnd > labelEnd + 2) {
          const url = source.slice(labelEnd + 2, urlEnd)
          if (/^(?:https?:\/\/|mailto:|\/|#)/.test(url)) {
            flush()
            const label = source.slice(index + 1, labelEnd)
            for (const span of inlineSpans(label, depth + 1)) {
              appendSpan(result, { ...span, tone: 'link', underline: true })
            }
            if (label !== url) {
              appendSpan(result, { text: ' (' })
              appendSpan(result, { text: url, tone: 'link', underline: true })
              appendSpan(result, { text: ')' })
            }
            index = urlEnd + 1
            continue
          }
        }
      }
    }
    if (source.startsWith('http://', index) || source.startsWith('https://', index)) {
      const match = /^https?:\/\/[^\s<>()]+/.exec(source.slice(index))
      if (match) {
        const link = match[0].replace(/[.,;!?]+$/, '')
        flush()
        appendSpan(result, { text: link, tone: 'link', underline: true })
        index += link.length
        continue
      }
    }
    let formatted = false
    for (const marker of markers) {
      if (!source.startsWith(marker, index)) continue
      if (marker === '_' && index > 0 && /[\p{L}\p{N}]/u.test(source[index - 1]!)) continue
      const start = index + marker.length
      const close = source.indexOf(marker, start)
      if (close <= start || /\s/.test(source[start]!) || /\s/.test(source[close - 1]!)) continue
      flush()
      const bold = marker === '**' || marker === '__'
      const italic = marker === '*' || marker === '_'
      const strike = marker === '~~'
      for (const span of inlineSpans(source.slice(start, close), depth + 1)) {
        appendSpan(result, { ...span, tone: span.tone ?? (bold ? 'strong' : italic ? 'emphasis' : undefined),
          bold: bold || span.bold, italic: italic || span.italic, strike: strike || span.strike })
      }
      index = close + marker.length
      formatted = true
      break
    }
    if (formatted) continue
    plain += char
    index++
  }
  flush()
  return result
}
