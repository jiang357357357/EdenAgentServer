import { isMediaPayloadField, isRuntimeProtocolField, isSignedThinking } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { mapModelHistoryText } from './model-history-text.ts'

/** Replace exact known values in decoded leaves, keeping provider protocol and JSON syntax intact. */
export function knownValueProjection(known: ReadonlyMap<string, string>, minimumLength: number,
  opaque: (value: JsonValue) => boolean = () => false): (value: JsonValue) => JsonValue {
  const values = new Map([...known].filter(([raw]) => raw.length >= minimumLength))
  const patterns = valuePatterns([...values.keys()])
  const prose = (text: string) => replaceProse(text, patterns, values)
  const visit = (value: JsonValue): JsonValue => {
    if (opaque(value)) return value
    if (typeof value === 'string') return mapModelHistoryText(value, visit, prose)
    if (typeof value === 'number') return values.get(String(value)) ?? value
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object' || isSignedThinking(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, isRuntimeProtocolField(key, value) || isMediaPayloadField(key, value) ? item : visit(item)]))
  }
  return visit
}

function replaceProse(text: string, patterns: RegExp[], values: ReadonlyMap<string, string>): string {
  // Match the original text once per pattern; newly generated references must never be scanned again.
  const matches = patterns.flatMap(pattern => [...text.matchAll(pattern)])
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length)
  let result = '', cursor = 0
  for (const match of matches) {
    if (match.index < cursor) continue
    result += text.slice(cursor, match.index) + values.get(match[0])!
    cursor = match.index + match[0].length
  }
  return result + text.slice(cursor)
}

function valuePatterns(values: string[]): RegExp[] {
  values.sort((a, b) => b.length - a.length)
  const patterns: RegExp[] = []
  for (let at = 0; at < values.length; at += 128) {
    const alternatives = values.slice(at, at + 128).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(?<![A-Za-z0-9_-])(?:${alternatives.join('|')})(?![A-Za-z0-9_-])`, 'g'))
  }
  return patterns
}
