import { cells, graphemes } from './screen-text.ts'

export type SpanTone = 'strong' | 'emphasis' | 'link' | 'inlineCode' | 'keyword' | 'string' | 'number'
  | 'comment' | 'function' | 'type' | 'attribute' | 'variable' | 'punctuation' | 'meta'

export interface StyledSpan {
  text: string
  tone?: SpanTone | undefined
  bold?: boolean | undefined
  italic?: boolean | undefined
  underline?: boolean | undefined
  strike?: boolean | undefined
}

export function appendSpan(result: StyledSpan[], span: StyledSpan): void {
  if (!span.text) return
  const previous = result.at(-1)
  if (previous && previous.tone === span.tone && previous.bold === span.bold && previous.italic === span.italic
    && previous.underline === span.underline && previous.strike === span.strike) {
    previous.text += span.text
    return
  }
  result.push({ ...span })
}

/** Wrap on terminal cell boundaries while carrying each grapheme's style forward. */
export function wrapStyled(spans: readonly StyledSpan[], width: number): StyledSpan[][] {
  const limit = Math.max(1, width)
  const lines: StyledSpan[][] = [[]]
  let used = 0
  for (const span of spans) for (const cluster of graphemes(span.text)) {
    if (cluster === '\n') { lines.push([]); used = 0; continue }
    const size = cells(cluster)
    if (size > limit) continue
    if (used + size > limit && used > 0) { lines.push([]); used = 0 }
    appendSpan(lines[lines.length - 1]!, { ...span, text: cluster })
    used += size
  }
  return lines
}

export function splitStyledLines(spans: readonly StyledSpan[]): StyledSpan[][] {
  const lines: StyledSpan[][] = [[]]
  for (const span of spans) {
    const parts = span.text.split('\n')
    for (let index = 0; index < parts.length; index++) {
      if (index) lines.push([])
      appendSpan(lines[lines.length - 1]!, { ...span, text: parts[index]! })
    }
  }
  return lines
}
