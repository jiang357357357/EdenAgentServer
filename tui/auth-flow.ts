import type { TuiConfig } from './config.ts'
import { CoreAuthExpired, clearCredential, loadCredential, loginWithCore, logoutWithCore,
  saveCredential, verifyCredential } from './core-login.ts'
import type { CoreCredential } from './core-login.ts'
import type { Terminal } from './terminal.ts'

type Stage = 'username' | 'password' | 'connecting' | 'authenticated' | 'server_error' | 'local'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function label(credential: CoreCredential | undefined): string {
  return credential?.user.displayName || credential?.user.username || ''
}

/** Core authentication belongs to this TUI process; only a user scoped token is persisted. */
export class AuthFlow {
  private credential: CoreCredential | undefined
  private stage: Stage = 'connecting'
  private username = ''
  private notice = ''

  constructor(private readonly config: TuiConfig, private readonly terminal: Terminal,
    private readonly connect: (token?: string) => Promise<void>, private readonly disconnect: () => void) {}

  get token(): string | undefined { return this.credential?.token }
  get authenticated(): boolean { return this.stage === 'authenticated' || this.stage === 'local' }

  async bootstrap(): Promise<void> {
    this.terminal.home()
    this.terminal.setAuth('connecting', '', '正在恢复登录')
    if (this.config.origin === 'local') { await this.activate(undefined, false); return }
    let credential: CoreCredential | undefined
    try { credential = await loadCredential(this.config) }
    catch (error) { this.startLogin(message(error)); return }
    if (!credential) { this.startLogin(); return }
    await this.activate(credential, true)
  }

  private async activate(candidate: CoreCredential | undefined, verify: boolean): Promise<void> {
    this.stage = 'connecting'
    this.terminal.setAuth('connecting', label(candidate), verify ? '正在验证已保存的 Core 登录' : '正在连接 Agent Server')
    let credential = candidate
    if (credential && verify) {
      try { credential = await verifyCredential(this.config, credential) }
      catch (error) {
        if (error instanceof CoreAuthExpired) {
          if (credential.source === 'stored') await clearCredential(this.config).catch(() => {})
          this.credential = undefined
          this.startLogin(message(error))
          return
        }
        this.credential = credential
        this.serverError(message(error))
        return
      }
    }
    this.credential = credential
    this.terminal.setInputMode('normal')
    this.terminal.setAuth(credential ? 'authenticated' : 'local', label(credential), this.notice)
    try {
      await this.connect(credential?.token)
      this.stage = credential ? 'authenticated' : 'local'
      this.terminal.setAuth(this.stage, label(credential), this.notice)
      this.notice = ''
    } catch (error) {
      this.disconnect()
      this.serverError(message(error))
    }
  }

  private serverError(reason: string): void {
    this.stage = 'server_error'
    this.terminal.setInputMode('normal')
    this.terminal.setAuth('server_error', label(this.credential), `${reason}；输入 /retry 重试`)
  }

  disconnected(reason: string): void { this.serverError(reason) }

  startLogin(reason = ''): void {
    if (this.config.origin !== 'mon') throw new Error('尘世无需 Core 登录')
    this.disconnect()
    this.credential = undefined
    this.stage = 'username'
    this.username = ''
    this.terminal.home()
    this.terminal.setInputMode('username')
    this.terminal.setAuth('username', '', reason)
  }

  async retry(): Promise<void> {
    if (this.stage !== 'server_error') throw new Error('当前没有需要重试的连接')
    await this.activate(this.credential, Boolean(this.credential))
  }

  async input(line: string): Promise<boolean> {
    if (this.stage === 'username') {
      if (!line.trim()) { this.terminal.setAuth('username', '', 'Core 用户名不能为空'); return true }
      this.username = line.trim()
      this.stage = 'password'
      this.terminal.setInputMode('password')
      this.terminal.setAuth('password', this.username)
      return true
    }
    if (this.stage === 'password') {
      if (line === '/login-back') { this.startLogin(); return true }
      if (!line) { this.terminal.setAuth('password', this.username, 'Core 密码不能为空'); return true }
      this.stage = 'connecting'
      this.terminal.setAuth('connecting', this.username, '正在登录 Mon Core')
      try {
        const credential = await loginWithCore(this.config, this.username, line)
        this.notice = ''
        try { await saveCredential(this.config, credential) }
        catch (error) { this.notice = `登录成功，但保存登录信息失败：${message(error)}` }
        await this.activate(credential, false)
      } catch (error) {
        this.stage = 'password'
        this.terminal.setInputMode('password')
        this.terminal.setAuth('password', this.username, message(error))
      }
      return true
    }
    return false
  }

  async logout(): Promise<void> {
    if (this.config.origin !== 'mon') throw new Error('尘世无需 Core 退出登录')
    const token = this.credential?.token
    const external = this.credential?.source === 'external'
    this.disconnect()
    this.credential = undefined
    this.stage = 'connecting'
    this.terminal.setInputMode('normal')
    this.terminal.setAuth('connecting', '', '正在退出 Core 登录')
    let warning = ''
    try { await clearCredential(this.config) }
    catch (error) { warning = `清除本地登录信息失败：${message(error)}` }
    if (token && !external) try { await logoutWithCore(this.config, token) }
    catch { warning = warning || '远端退出未确认；本地登录信息已清除' }
    if (external) warning = warning || '外部令牌仍由环境变量或文件管理'
    this.startLogin(warning)
  }

  accountLines(): string[] {
    if (this.config.origin === 'local') return ['尘世世界不需要 Mon Core 登录']
    const credential = this.credential
    if (!credential) return ['未登录 Mon Core']
    return [
      `账号：${label(credential)}`, `用户名：${credential.user.username}`, `用户 ID：${credential.user.id}`,
      `Core：${credential.coreUrl}`, `来源：${credential.source === 'external' ? '外部令牌' : 'TUI 保存的令牌'}`,
      `有效期：${credential.expiresAt ? new Date(credential.expiresAt).toLocaleString('zh-CN') : '由 Core 确认'}`,
      '令牌和密码不会显示在界面中',
    ]
  }

  report(error: unknown): void {
    this.terminal.setAuth(this.stage, label(this.credential) || this.username, message(error))
  }
}
