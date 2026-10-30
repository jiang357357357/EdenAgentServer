import type { ToolResult } from '@trycua/cua-driver'
import type { DriverAction } from './contracts.ts'

/** Diagnostic text keeps the upstream explanation without publishing native addressing handles. */
export function nativeDiagnosticMessage(text: string): string {
  return text.slice(0, 12000)
    .replace(/\b(window_id|HWND|pid)\s*[:=]?\s*(?:0x[\da-f]+|\d+)/gi, '$1 [target]')
    .replace(/\bs[\da-f]{8,}(?::\d+)?\b/gi, '[snapshot]')
    .replace(/\beden-[\da-f-]{36}\b/gi, '[session]')
}

export function nativeDiagnosticFacts(result: ToolResult): Partial<DriverAction> {
  const driverMessage = result.isError || result.action ? nativeDiagnosticMessage(result.text) : ''
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(result.structuredJson ?? '{}') ?? {} } catch { /* Text remains available if extensions are not JSON. */ }
  const refusal = data.refusal as { code?: unknown } | undefined
  const code = result.errorCode ?? (typeof refusal?.code === 'string' ? refusal.code : undefined)
  const escalation = data.escalation as Record<string, unknown> | undefined
  const hints = Object.fromEntries(['target', 'recommended', 'reason'].flatMap(key =>
    typeof escalation?.[key] === 'string' ? [[key, nativeDiagnosticMessage(escalation[key]).slice(0, 1000)]] : []))
  return { ...(driverMessage ? { driverMessage } : {}),
    ...(code && /^[A-Za-z0-9_]{1,100}$/.test(code) ? { code } : {}),
    ...(Object.keys(hints).length ? { diagnostics: { driver: { escalation: hints } } } : {}) }
}
