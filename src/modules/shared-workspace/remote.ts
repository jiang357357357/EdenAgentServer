import { createHash } from 'node:crypto'
import type { SharedCredential, SharedRemote } from './contracts.ts'

const maximumBytes = 16 * 1024 * 1024
export class SharedRemoteError extends Error {
  constructor(readonly status: number, readonly body: { error: string; current?: unknown }) {
    const summary = status === 401 ? '共享资料库账号认证已失效（401）' : status === 403
      ? '共享资料库不可用或没有操作权限（403）' : `共享资料库请求失败（${status}）`
    super(`${summary}：${body.error}`)
  }
}

/** Credentials are fetched from a live, verified connection for every request, never persisted. */
export class SharedWorkspaceRemote implements SharedRemote {
  private registered: string | undefined
  private registering: Promise<void> | undefined
  constructor(private readonly credentials: () => Promise<SharedCredential>, private readonly signal: () => AbortSignal,
    private readonly fetcher: typeof fetch = fetch, private readonly device?: () => Promise<string>) {}

  resetRegistration(): void { this.registered = undefined }

  async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const response = await this.fetch(method, endpoint, body === undefined ? undefined : JSON.stringify(body), 'application/json')
    const bytes = await readBounded(response, maximumBytes)
    return (bytes.byteLength ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null) as T
  }

  async upload(spaceId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > maximumBytes || digest(bytes) !== sha256) throw new Error('共享文件大小或校验和无效')
    const response = await this.fetch('PUT', `spaces/${encodeURIComponent(spaceId)}/blobs/${sha256}`, Buffer.from(bytes), 'application/octet-stream')
    await response.body?.cancel()
  }

  async download(spaceId: string, sha256: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('共享文件校验和无效')
    const response = await this.fetch('GET', `spaces/${encodeURIComponent(spaceId)}/blobs/${sha256}`)
    const bytes = await readBounded(response, maximumBytes)
    if (digest(bytes) !== sha256) throw new Error('共享文件传输校验失败')
    return bytes
  }

  private async fetch(method: string, endpoint: string, body?: BodyInit, contentType?: string): Promise<Response> {
    const signal = this.signal()
    signal.throwIfAborted()
    const credential = await this.credentials()
    signal.throwIfAborted()
    const deviceId = await this.device?.()
    if (deviceId && endpoint !== 'capabilities' && !endpoint.startsWith('devices'))
      await this.registerDevice(credential, deviceId, signal)
    return this.send(credential, signal, method, endpoint, body, contentType, deviceId)
  }

  private async registerDevice(credential: SharedCredential, deviceId: string, signal: AbortSignal) {
    const key = createHash('sha256').update(credential.coreBaseUrl).update('\0').update(credential.token).digest('hex')
    if (this.registered === key) return
    if (this.registering) { await this.registering; if (this.registered === key) return }
    const task = this.send(credential, signal, 'POST', 'devices', JSON.stringify({ deviceId, name: 'EDEN Agent' }), 'application/json', deviceId)
      .then(async response => { await response.body?.cancel(); this.registered = key })
    this.registering = task
    try { await task } finally { if (this.registering === task) this.registering = undefined }
  }

  private async send(credential: SharedCredential, signal: AbortSignal, method: string, endpoint: string,
    body?: BodyInit, contentType?: string, deviceId?: string): Promise<Response> {
    signal.throwIfAborted()
    const base = new URL('api/shared-workspace/v1/', `${credential.coreBaseUrl.replace(/\/+$/, '')}/`)
    if (!/^[a-zA-Z0-9_/?=&%-]+$/.test(endpoint) || endpoint.includes('..') || /%2f|%5c|%2e/i.test(endpoint))
      throw new Error('共享资料库接口路径无效')
    const url = new URL(endpoint, base)
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('共享资料库接口越界')
    const response = await this.fetcher(url, { method, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { Authorization: `Token ${credential.token}`, ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(deviceId ? { 'X-Shared-Workspace-Device': deviceId } : {}) },
      ...(body === undefined ? {} : { body }) })
    if (response.ok) return response
    throw new SharedRemoteError(response.status, await errorDetail(response))
  }
}

async function errorDetail(response: Response): Promise<{ error: string; current?: unknown }> {
  const bytes = await readBounded(response, 64 * 1024)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (parsed && typeof parsed === 'object') {
      const detail = 'error' in parsed ? parsed.error : 'detail' in parsed ? parsed.detail : undefined
      if (typeof detail === 'string') return { error: detail.slice(0, 200).replace(/[\r\n]/g, ' '),
        ...('current' in parsed ? { current: parsed.current } : {}) }
    }
  } catch { /* Only a bounded, structured server error crosses this boundary. */ }
  return { error: 'request_failed' }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('共享资料库响应超过大小限制')
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
