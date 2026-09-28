import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { RuntimeOrigin } from '@eden/api'

export interface TuiConfig {
  origin: RuntimeOrigin
  port: number
  tokenFile: string
  coreTokenFile?: string
  coreUrl: string
  authFile: string
  sessionId?: string
}

export const usage = `Eden Agent 终端保底界面

用法：eden [选项]
  --origin mon|local       世界，默认 mon
  --port 端口               默认 local=40093、mon=40092
  --token-file 路径         Server 能力令牌文件
  --core-token-file 路径    读取已有 Mon Core 令牌（优先于 TUI 保存的登录）
  --core-url URL            Core 地址，默认 http://127.0.0.1:40011
  --session UUID            启动时打开指定会话
  --help                    显示帮助

Server 需要已经运行。退出本界面不会停止 Server 或正在执行的回合。`

function runningTokenFile(origin: RuntimeOrigin, port: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      const value = (name: string) => entries.find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1)
      if (value('EDEN_AGENT_RUNTIME_ORIGIN') !== origin) continue
      const actualPort = Number(value('EDEN_AGENT_PORT') ?? (origin === 'mon' ? 40092 : 40093))
      if (actualPort !== port) continue
      const dataRoot = value('EDEN_AGENT_DATA_ROOT')
      if (!dataRoot || !path.isAbsolute(dataRoot)) continue
      const file = path.join(dataRoot, 'capability.token')
      if (existsSync(file)) return file
    } catch { /* Other processes may not expose their environment. */ }
  }
  return undefined
}

export function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): TuiConfig | undefined {
  if (args.includes('--help') || args.includes('-h')) return undefined
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!key || !value || !['--origin', '--port', '--token-file', '--core-token-file', '--core-url', '--session'].includes(key)) {
      throw new Error(`参数无效。\n${usage}`)
    }
    options.set(key, value)
  }
  const origin = options.get('--origin') ?? env.EDEN_AGENT_RUNTIME_ORIGIN ?? 'mon'
  if (origin !== 'mon' && origin !== 'local') throw new Error('--origin 必须是 mon 或 local')
  const port = Number(options.get('--port') ?? env.EDEN_AGENT_PORT ?? (origin === 'mon' ? 40092 : 40093))
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('--port 必须是 1–65535')
  const cwd = process.cwd()
  const projectRoot = path.basename(cwd) === 'Server' ? path.dirname(cwd) : cwd
  const dataRoot = path.resolve(env.EDEN_AGENT_DATA_ROOT ?? path.join(projectRoot, 'Data', 'realms', origin))
  const tokenFile = path.resolve(options.get('--token-file') ?? env[origin === 'mon' ? 'EDEN_AGENT_MON_TOKEN_FILE' : 'EDEN_AGENT_LOCAL_TOKEN_FILE']
    ?? runningTokenFile(origin, port) ?? path.join(dataRoot, 'capability.token'))
  const coreTokenFile = options.get('--core-token-file') ?? env.EDEN_AGENT_CORE_TOKEN_FILE
  const coreUrl = options.get('--core-url') ?? env.MON_CORE_BASE_URL ?? 'http://127.0.0.1:40011'
  const parsedUrl = new URL(coreUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error('--core-url 必须是无内嵌凭据的 HTTP(S) 地址')
  const stateRoot = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME : path.join(homedir(), '.local', 'state')
  const coreKey = createHash('sha256').update(parsedUrl.href.replace(/\/+$/, '')).digest('hex').slice(0, 16)
  const authFile = path.join(stateRoot, 'eden-agent', `tui-auth-${coreKey}.json`)
  const sessionId = options.get('--session')
  return { origin, port, tokenFile, coreUrl, authFile,
    ...(coreTokenFile ? { coreTokenFile: path.resolve(coreTokenFile) } : {}),
    ...(sessionId ? { sessionId } : {}) }
}

export function capabilityToken(config: TuiConfig, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnvironment = (env[config.origin === 'mon' ? 'EDEN_AGENT_MON_CAPABILITY_TOKEN' : 'EDEN_AGENT_LOCAL_CAPABILITY_TOKEN'] ?? env.EDEN_AGENT_CAPABILITY_TOKEN)?.trim()
  const token = fromEnvironment || readFileSync(config.tokenFile, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('Server 能力令牌格式无效')
  return token
}
