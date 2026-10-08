import { appendSpan, type StyledSpan } from './styled-text.ts'

const escaped = /[\\`*_{}\[\]()#+.!~>-]/
const markers = ['**', '__', '~~', '*', '_'] as const
type InlineToken = { end: number; spans: StyledSpan[] }

function codeToken(source: string, index: number): InlineToken | undefined {
  if (source[index] !== '`') return undefined
  const marker = /^`+/.exec(source.slice(index))![0]
  const close = source.indexOf(marker, index + marker.length)
  if (close <= index + marker.length) return undefined
  return { end: close + marker.length, spans: [{ text: source.slice(index + marker.length, close), tone: 'inlineCode' }] }
}

function linkToken(source: string, index: number, depth: number): InlineToken | undefined {
  if (source[index] !== '[') return undefined
  const labelEnd = source.indexOf(']', index + 1)
  if (labelEnd <= index + 1 || source[labelEnd + 1] !== '(') return undefined
  const urlEnd = source.indexOf(')', labelEnd + 2)
  if (urlEnd <= labelEnd + 2) return undefined
  const url = source.slice(labelEnd + 2, urlEnd)
  if (!/^(?:https?:\/\/|mailto:|\/|#)/.test(url)) return undefined
  const label = source.slice(index + 1, labelEnd)
  const spans: StyledSpan[] = inlineSpans(label, depth + 1).map(span => ({ ...span, tone: 'link', underline: true }))
  if (label !== url) spans.push({ text: ' (' }, { text: url, tone: 'link', underline: true }, { text: ')' })
  return { end: urlEnd + 1, spans }
}

function bareLinkToken(source: string, index: number): InlineToken | undefined {
  if (!source.startsWith('http://', index) && !source.startsWith('https://', index)) return undefined
  const match = /^https?:\/\/[^\s<>()]+/.exec(source.slice(index))
  if (!match) return undefined
  const link = match[0].replace(/[.,;!?]+$/, '')
  return { end: index + link.length, spans: [{ text: link, tone: 'link', underline: true }] }
}

function markerSpan(span: StyledSpan, marker: string): StyledSpan {
  const bold = marker === '**' || marker === '__'
  const italic = marker === '*' || marker === '_'
  const strike = marker === '~~'
  return { ...span, tone: span.tone ?? (bold ? 'strong' : italic ? 'emphasis' : undefined),
    bold: bold || span.bold, italic: italic || span.italic, strike: strike || span.strike }
}

function emphasisToken(source: string, index: number, depth: number): InlineToken | undefined {
  for (const marker of markers) {
    if (!source.startsWith(marker, index)) continue
    if (marker === '_' && index > 0 && /[\p{L}\p{N}]/u.test(source[index - 1]!)) continue
    const start = index + marker.length
    const close = source.indexOf(marker, start)
    if (close <= start || /\s/.test(source[start]!) || /\s/.test(source[close - 1]!)) continue
    return { end: close + marker.length,
      spans: inlineSpans(source.slice(start, close), depth + 1).map(span => markerSpan(span, marker)) }
  }
  return undefined
}

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
    const token = codeToken(source, index) ?? linkToken(source, index, depth)
      ?? bareLinkToken(source, index) ?? emphasisToken(source, index, depth)
    if (token) {
      flush()
      for (const span of token.spans) appendSpan(result, span)
      index = token.end
    } else { plain += char; index++ }
  }
  flush()
  return result
}
