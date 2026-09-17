import { MonClient } from '@eden/integrations'
import { accountKey, type Account } from './context.ts'

export class AccountAuthentication {
  constructor(readonly coreBaseUrl: string) {}
  async verify(token: string, signal = AbortSignal.timeout(10000)): Promise<Account> {
    if (!token || token.length > 8192) throw new Error('请先登录 Core 账号')
    const raw = await new MonClient(this.coreBaseUrl, token).get('/api/users/me/profile/', signal)
    const profile = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const nested = profile.user && typeof profile.user === 'object' && !Array.isArray(profile.user) ? profile.user : {}
    const id = profile.id ?? nested.id
    if (!((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isSafeInteger(id)))) throw new Error('Core 未返回有效账号身份')
    return { key: accountKey(this.coreBaseUrl, String(id)), userId: String(id), coreBaseUrl: this.coreBaseUrl }
  }
}
