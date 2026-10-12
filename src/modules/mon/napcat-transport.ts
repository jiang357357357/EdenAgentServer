import { createHash, createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { MonServiceIdentity } from '@eden/integrations'

export interface NapcatTarget {
  baseUrl: string
  path: string
  resource: string
  token?: string
  identity?: MonServiceIdentity
  qqContext?: { session_id: string; bot_qq: string; contact_qq: string; group_qq?: string | undefined }
  groupAllowActions?: boolean
}
export interface NapcatRequest {
  action: string
  params: Record<string, unknown>
  request_id: string
  mode?: 'read' | 'write'
}
const resultSchema = z.object({ request_id: z.string(), status: z.enum(['success', 'failed', 'unknown']),
  action: z.string(), result: z.unknown().optional(), code: z.string().optional(), message: z.string().optional() })
export type NapcatResult = z.infer<typeof resultSchema>
const maxResponseBytes = 8 * 1024 * 1024

function headers(target: NapcatTarget, body: string): Record<string, string> {
  const values: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!target.identity) {
    if (!target.token) throw new Error('QQ Core connection is unavailable')
    return { ...values, Authorization: `Token ${target.token}` }
  }
  const identity = target.identity, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID()
  const service = 'monagent', scope = 'self_awake:user_context'
  const digest = createHash('sha256').update(body).digest('hex')
  const signature = createHmac('sha256', identity.secret).update(
    [service, scope, timestamp, nonce, identity.userId, 'POST', target.path, digest].join('\n')).digest('hex')
  return { ...values, 'X-Mon-Service-ID': service, 'X-Mon-Service-Scope': scope,
    'X-Mon-Service-Timestamp': timestamp, 'X-Mon-Service-Nonce': nonce,
    'X-Mon-Service-Signature': signature, 'X-Mon-Subject-User-ID': identity.userId }
}

export async function readNapcatResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxResponseBytes) throw new Error('QQ response exceeds size limit')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('QQ response is empty')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxResponseBytes) throw new Error('QQ response exceeds size limit')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** One attempt only: a lost write receipt must never trigger an automatic resend. */
export async function sendNapcatRequest(target: NapcatTarget, input: NapcatRequest,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<NapcatResult> {
  signal.throwIfAborted()
  const body = JSON.stringify({ ...input, ...(target.qqContext ? { qq_context: target.qqContext } : {}) })
  const requestHeaders = headers(target, body)
  const url = new URL(target.path, target.baseUrl)
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(130_000)])
  try {
    const response = await fetcher(url, { method: 'POST', headers: requestHeaders, body,
      signal: requestSignal, redirect: 'error' })
    const envelope = z.object({ data: resultSchema.optional(), message: z.string().optional(), error: z.string().optional(),
      code: z.string().optional() }).parse(await readNapcatResponse(response))
    if (envelope.data && envelope.data.request_id === input.request_id && envelope.data.action === input.action)
      return envelope.data
    if (response.status >= 400 && response.status < 500)
      return { request_id: input.request_id, action: input.action, status: 'failed',
        code: envelope.code ?? `HTTP_${response.status}`, message: envelope.message ?? envelope.error ?? 'QQ request was rejected' }
    throw new Error('QQ receipt does not match this request')
  } catch {
    if (input.mode !== 'write') {
      signal.throwIfAborted()
      throw new Error('QQ capability service is unavailable or returned an invalid receipt')
    }
    return { request_id: input.request_id, action: input.action, status: 'unknown', code: 'RECEIPT_UNKNOWN',
      message: '操作可能已执行，但未获得有效回执。不要自动重试；先查询实际状态。' }
  }
}

export function napcatJson(result: NapcatResult): JsonValue { return toJson(result) }
