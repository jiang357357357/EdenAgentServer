import { cells, fit, graphemes } from './screen-text.ts'
import type { SpanTone } from './styled-text.ts'
import type { ColoredLine } from './screen-state.ts'

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

export function style(line: ColoredLine, width: number, color: boolean): string {
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
