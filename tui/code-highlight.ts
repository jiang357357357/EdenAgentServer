import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { appendSpan, type SpanTone, type StyledSpan } from './styled-text.ts'

for (const [name, grammar] of Object.entries({ bash, css, diff, go, javascript, json, markdown,
  python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, grammar)

const aliases: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rs: 'rust',
  sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown',
  html: 'xml', svg: 'xml', htm: 'xml',
}

const tokenTone: Record<string, SpanTone> = {
  keyword: 'keyword', built_in: 'keyword', literal: 'number', number: 'number',
  string: 'string', regexp: 'string', comment: 'comment', doctag: 'comment',
  title: 'function', function_: 'function', class_: 'type', type: 'type',
  attr: 'attribute', attribute: 'attribute', property: 'attribute',
  variable: 'variable', params: 'variable', symbol: 'variable',
  punctuation: 'punctuation', operator: 'punctuation', meta: 'meta',
  addition: 'string', deletion: 'keyword', section: 'function',
}

const cache = new Map<string, StyledSpan[]>()

function decodeEntity(entity: string): string {
  if (entity === '&amp;') return '&'
  if (entity === '&lt;') return '<'
  if (entity === '&gt;') return '>'
  if (entity === '&quot;') return '"'
  const hex = /^&#x([\da-f]+);$/i.exec(entity)
  const decimal = /^&#(\d+);$/.exec(entity)
  const point = hex ? Number.parseInt(hex[1]!, 16) : decimal ? Number.parseInt(decimal[1]!, 10) : -1
  return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
}

function fromHtml(html: string): StyledSpan[] {
  const spans: StyledSpan[] = []
  const tones: (SpanTone | undefined)[] = []
  const tokens = /<span class="([^"]+)">|<\/span>|&(?:amp|lt|gt|quot|#x[\da-f]+|#\d+);|[^<&]+|[<&]/gi
  for (const match of html.matchAll(tokens)) {
    if (match[1]) {
      const classes = match[1].split(/\s+/).map(value => value.replace(/^hljs-/, ''))
      tones.push(classes.map(value => tokenTone[value]).find(Boolean) ?? tones.at(-1))
    } else if (match[0] === '</span>') {
      tones.pop()
    } else {
      const text = match[0].startsWith('&') ? decodeEntity(match[0]) : match[0]
      appendSpan(spans, { text, ...(tones.at(-1) ? { tone: tones.at(-1) } : {}) })
    }
  }
  return spans
}

/** Highlight only declared, supported languages; unknown and long blocks stay readable. */
export function codeSpans(source: string, declaredLanguage: string): StyledSpan[] {
  const name = declaredLanguage.toLowerCase().replace(/[^\w+#.-].*$/, '')
  const language = aliases[name] ?? name
  if (!source || source.length > 12_000 || !hljs.getLanguage(language)) return [{ text: source }]
  const key = language + '\0' + source
  const previous = cache.get(key)
  if (previous) { cache.delete(key); cache.set(key, previous); return previous }
  try {
    const spans = fromHtml(hljs.highlight(source, { language, ignoreIllegals: true }).value)
    if (spans.map(span => span.text).join('') !== source) return [{ text: source }]
    cache.set(key, spans)
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return spans
  } catch {
    return [{ text: source }]
  }
}
