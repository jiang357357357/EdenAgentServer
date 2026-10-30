import { acquireMonServiceLease } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { State } from './contracts.ts'

/** Use Agent's verified service lease; do not create a second account identity. */
export class OsCoreClient {
  private token: { value: string; expiresAt: number } | undefined
  private pending: Promise<string> | undefined
  private readonly abort = new AbortController()
  constructor(private readonly identity: MonServiceIdentity | undefined) {}
  async request(method: string, pathname: string, payload?: unknown): Promise<State> {
    if (!this.identity) throw new Error('请先在配置工具中绑定后台服务账号')
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.credential()
      const response = await fetch(`${this.identity.coreBaseUrl.replace(/\/$/, '')}${pathname}`, { method, redirect: 'error',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
        headers: { Authorization: `Token ${token}`, 'content-type': 'application/json', Accept: 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
      if (response.status === 401 && attempt === 0) { await response.body?.cancel(); this.token = undefined; continue }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Core ${pathname} 返回 HTTP ${response.status}`) }
      return await response.json() as State
    }
    throw new Error('Core 服务账号认证失败')
  }
  private credential(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return Promise.resolve(this.token.value)
    return this.pending ??= this.exchange().finally(() => { this.pending = undefined })
  }
  private async exchange(): Promise<string> {
    const lease = await acquireMonServiceLease(this.identity!, this.abort.signal)
    this.token = { value: lease.token, expiresAt: Math.max(Date.now() + 1000, lease.expiresAt - 60000) }
    return lease.token
  }
  close() { this.abort.abort(); this.token = undefined }
}
