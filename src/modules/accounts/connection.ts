import type { JsonValue } from '@eden/api'
import { AccountAuthentication } from './authentication.ts'
import { withAccount, type Account } from './context.ts'

export class AccountConnection {
  account: Account | undefined
  private token = ''
  private verifiedAt = 0
  private refreshing: Promise<void> | undefined
  constructor(private readonly authentication: AccountAuthentication, private readonly recover: () => Promise<void>) {}
  async initialize(token: string): Promise<void> {
    if (this.account) throw new Error('账号已绑定，请重新连接以切换账号')
    const account = await this.authentication.verify(token)
    await this.recover()
    this.token = token; this.account = account; this.verifiedAt = Date.now()
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (!this.account) return Promise.reject(new Error('请先登录 Core 账号'))
    if (Date.now() - this.verifiedAt < 30000) return Promise.resolve()
    this.verifiedAt = 0
    const pending = Promise.resolve().then(() => this.authentication.verify(this.token)).then(account => {
      if (account.key !== this.account?.key) throw new Error('账号身份已改变，请重新连接')
      this.verifiedAt = Date.now()
    })
    this.refreshing = pending
    const clear = () => { if (this.refreshing === pending) this.refreshing = undefined }
    void pending.then(clear, clear)
    return pending
  }
  active(): boolean { return this.refreshing === undefined && this.account !== undefined && this.verifiedAt > 0 && Date.now() - this.verifiedAt < 45000 }
  async run<T>(params: JsonValue, action: () => T): Promise<Awaited<T>> {
    await this.refresh()
    this.checkCredentials(params)
    return await withAccount(this.account, action)
  }
  private checkCredentials(value: JsonValue): void {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) this.checkCredentials(item); return }
    if ('coreToken' in value && value.coreToken !== this.token) throw new Error('Core 凭据与当前登录账号不一致')
    if (typeof value.coreBaseUrl === 'string' && new URL(value.coreBaseUrl).href.replace(/\/+$/, '') !== new URL(this.authentication.coreBaseUrl).href.replace(/\/+$/, '')) throw new Error('Core 服务与当前登录账号不一致')
    for (const item of Object.values(value)) this.checkCredentials(item)
  }
}
