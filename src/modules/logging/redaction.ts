const hidden = '[已脱敏]'
const sensitive = /^(?:key|auth|authorization|cookie|setcookie|password|passwd|secret|token|apikey|accesskey|privatekey|clientsecret|credential|credentials|connectionstring)$|(?:token|password|passwd|secret|apikey|privatekey|credentials)$/i
const secretAssignment = /(\b(?:[a-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|private[_-]?key|credential|signature)[a-z0-9_.-]*|key|auth|authorization|cookie|set[_-]?cookie)(?:["']?)\s*[:=]\s*)("[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;"'<>}&]+)/gi

function sensitiveKey(key: string): boolean { return sensitive.test(key.replace(/[^a-z0-9]/gi, '')) }

function querySecret(match: string, prefix: string, key: string): string {
  try { return sensitiveKey(decodeURIComponent(key)) ? `${prefix}${hidden}` : match }
  catch { return sensitiveKey(key) ? `${prefix}${hidden}` : match }
}

function errorRecord(error: Error): Record<string, unknown> {
  return { name: error.name, message: error.message, stack: error.stack,
    code: 'code' in error ? error.code : undefined, cause: error.cause }
}

export function safeLogText(value: string, limit = 8000): string {
  return value
    .slice(0, Math.max(4096, limit * 2))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, hidden)
    .replace(/(\b(?:bearer|basic)\s+)[^\s,;"'<>]+/gi, `$1${hidden}`)
    .replace(/([?&]([^=&#\s]+)=)[^&#\s"'<>]+/g, querySecret)
    .replace(secretAssignment, (_match, prefix: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : ''
      return `${prefix}${quote}${hidden}${quote}`
    })
    .replace(/((?:https?|wss?):\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${hidden}@`)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .slice(0, limit)
}

/** Log records are diagnostics, never a transport for arbitrary application objects. */
export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>()
  let remaining = 1000
  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 8) return '[已截断]'
    if (typeof value === 'string') return safeLogText(value)
    if (typeof value === 'bigint') return value.toString()
    if (value === undefined) return undefined
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) return '[循环引用]'
    seen.add(value)
    if (value instanceof Error) return visit(errorRecord(value), depth + 1)
    if (Array.isArray(value)) return value.slice(0, 100).map(item => visit(item, depth + 1))
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [safeLogText(key, 120),
      sensitiveKey(key) ? hidden : visit(item, depth + 1)]))
  }
  return visit(input, 0) as Record<string, unknown>
}
