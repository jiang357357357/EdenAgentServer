import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, chmod, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { TuiConfig } from './config.ts'

const userSchema = z.object({ id: z.union([z.string(), z.number().int()]), username: z.string(),
  displayName: z.string() }).strict()
const credentialSchema = z.object({ format: z.literal(1), coreUrl: z.string().url(),
  token: z.string().min(1).max(8192), user: userSchema, expiresAt: z.string().nullable() }).strict()

export type CoreUser = z.infer<typeof userSchema>
export type CoreCredential = z.infer<typeof credentialSchema> & { source: 'stored' | 'external' | 'login' }
export class CoreAuthExpired extends Error {}

function clientId(): string {
  return `eden-agent-tui:${os.hostname()}:${os.userInfo().username}`.slice(0, 128)
}

function coreUrl(config: TuiConfig): string { return new URL(config.coreUrl).href.replace(/\/+$/, '') }

function userFrom(value: unknown): CoreUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core 账号资料格式无效')
  const record = value as Record<string, unknown>
  const nested = record.user && typeof record.user === 'object' && !Array.isArray(record.user)
    ? record.user as Record<string, unknown> : {}
  const id = record.id ?? nested.id
  const username = record.username ?? nested.username
  const displayName = record.display_name ?? nested.display_name ?? username
  return userSchema.parse({ id, username, displayName: String(displayName ?? '') })
}

async function request(config: TuiConfig, pathname: string, token: string, init: RequestInit = {}): Promise<Response> {
  try {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Token ${token}`)
    return await fetch(new URL(pathname, config.coreUrl), {
      ...init, signal: AbortSignal.timeout(15_000), headers,
    })
  } catch { throw new Error('连接 Mon Core 失败；检查 Core 地址和服务状态') }
}

export async function verifyCredential(config: TuiConfig, credential: CoreCredential): Promise<CoreCredential> {
  const response = await request(config, '/api/users/me/profile/', credential.token)
  if (response.status === 401 || response.status === 403) throw new CoreAuthExpired('Core 登录已失效，请重新登录')
  if (!response.ok) throw new Error(`读取 Core 账号失败（HTTP ${response.status}）`)
  const user = userFrom(await response.json())
  if (credential.user.id && String(credential.user.id) !== String(user.id)) {
    throw new CoreAuthExpired('Core 账号身份已改变，请重新登录')
  }
  return { ...credential, user }
}

export async function loginWithCore(config: TuiConfig, username: string, password: string): Promise<CoreCredential> {
  if (!username.trim() || !password) throw new Error('用户名和密码不能为空')
  let response: Response
  try {
    response = await fetch(new URL('/api/users/login/', config.coreUrl), {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', 'X-MON-CLIENT-ID': clientId(), 'X-MON-CLIENT-TYPE': 'agent_tui' },
      body: JSON.stringify({ username: username.trim(), password, client_id: clientId(), client_type: 'agent_tui' }),
    })
  } catch { throw new Error('连接 Mon Core 失败；检查 Core 地址和服务状态') }
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401
    ? 'Core 用户名或密码错误' : `Mon Core 登录失败（HTTP ${response.status}）`)
  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Mon Core 登录响应无效')
  const result = raw as Record<string, unknown>
  if (typeof result.token !== 'string' || !result.token || result.token.length > 8192) throw new Error('Mon Core 未返回有效登录令牌')
  const user = userFrom(result.user)
  return { format: 1, coreUrl: coreUrl(config), token: result.token, user,
    expiresAt: typeof result.expires_at === 'string' ? result.expires_at : null, source: 'login' }
}

export async function loadCredential(config: TuiConfig, env: NodeJS.ProcessEnv = process.env): Promise<CoreCredential | undefined> {
  const supplied = env.EDEN_AGENT_CORE_TOKEN?.trim() || (config.coreTokenFile ? (await readFile(config.coreTokenFile, 'utf8')).trim() : '')
  if (supplied) return { format: 1, coreUrl: coreUrl(config), token: supplied,
    user: { id: '', username: '', displayName: '' }, expiresAt: null, source: 'external' }
  let stats
  try { stats = await lstat(config.authFile) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!stats.isFile() || process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`TUI 登录文件权限不安全：${config.authFile}`)
  }
  const value = credentialSchema.parse(JSON.parse(await readFile(config.authFile, 'utf8')))
  if (value.coreUrl !== coreUrl(config)) return undefined
  return { ...value, source: 'stored' }
}

export async function saveCredential(config: TuiConfig, credential: CoreCredential): Promise<void> {
  const directory = path.dirname(config.authFile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  const temporary = path.join(directory, `.tui-auth-${randomUUID()}.tmp`)
  try {
    const { source: _source, ...value } = credential
    await writeFile(temporary, JSON.stringify(credentialSchema.parse(value)), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, config.authFile)
    if (process.platform !== 'win32') await chmod(config.authFile, 0o600)
  } finally { await rm(temporary, { force: true }) }
}

export async function clearCredential(config: TuiConfig): Promise<void> {
  await rm(config.authFile, { force: true })
}

export async function logoutWithCore(config: TuiConfig, token: string): Promise<void> {
  const response = await request(config, '/api/users/logout/', token, { method: 'POST' })
  if (!response.ok && response.status !== 401 && response.status !== 403) throw new Error(`Core 退出失败（HTTP ${response.status}）`)
}
