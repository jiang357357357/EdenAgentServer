import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { OsConfig } from '../modules/os/index.ts'
import type { MonServiceIdentity } from '@eden/integrations'

export function osConfig(workspaceRoot: string | undefined, dataRoot: string, identity: MonServiceIdentity | undefined,
  env: NodeJS.ProcessEnv): OsConfig | undefined {
  if (!ownsLocalCapabilities(workspaceRoot, dataRoot, env)) return undefined
  const root = path.resolve(env.EDEN_AGENT_OS_ROOT ?? legacyRoot(workspaceRoot!) ?? path.join(dataRoot, 'os'))
  const filename = path.join(root, '.monconfig')
  const values = existsSync(filename) ? ini(readFileSync(filename, 'utf8')) : new Map<string, string>()
  const get = (section: string, key: string, fallback: string) => env[`MONOS_${key}`] ?? values.get(`${section}.${key}`) ?? fallback
  const file = (section: string, key: string, fallback: string) => path.resolve(root, get(section, key, fallback))
  const number = (section: string, key: string, fallback: number, min = 1, max = 86400) => {
    const n = Number(get(section, key, String(fallback)))
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`OS 配置 ${section}.${key} 无效`)
    return n
  }
  const bool = (key: string, fallback: boolean) => {
    const raw = get('self_awake', key, String(fallback)).toLowerCase()
    if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(raw)) throw new Error(`OS 配置 ${key} 无效`)
    return ['true', '1', 'yes', 'on'].includes(raw)
  }
  const wakeFile = env.MONOS_SELF_AWAKE_STATE_PATH
  const componentVersion = productVersion(workspaceRoot)
  const legacyWakeDir = wakeFile ? path.dirname(path.resolve(wakeFile)) : file('self_awake', 'DATA_DIR', 'Data/SelfAwake')
  const legacyMemoDir = file('memo', 'DATA_DIR', 'Data/MemoScheduler')
  const account = identity && !wakeFile ? createHash('sha256').update(`${identity.coreBaseUrl.replace(/\/$/, '')}\n${identity.userId}`).digest('hex') : undefined
  return { root, identity, componentVersion, databasePath: file('database', 'NAME', 'Data/DB/SQLite/monos_db.sqlite3'),
    vectorDir: file('database', 'VECTOR_DIR', 'Data/DB/Vector'), legacyVectorDir: file('database', 'LEGACY_FAISS_DIR', 'Data/DB/FAISS'),
    modelPath: file('model', 'MODEL_PATH', 'Data/Models/bge-small-zh-v1.5'),
    wakeDir: account ? path.join(legacyWakeDir, 'accounts', account) : legacyWakeDir,
    memoDir: account ? path.join(legacyMemoDir, 'accounts', account) : legacyMemoDir,
    ...(account ? { legacyWakeDir, legacyMemoDir } : {}),
    port: Number(env.EDEN_AGENT_OS_PORT ?? number('mcp', 'SERVER_PORT', 40072, 0, 65535)),
    mcpPath: '/' + get('mcp', 'SERVER_PATH', '/mcp').replace(/^\/+/, ''),
    controlSeconds: number('task', 'CONTROL_TICK_SECONDS', 2), pollSeconds: number('self_awake', 'AGENT_ASYNC_POLL_SECONDS', 15),
    retryMinutes: number('self_awake', 'AGENT_FALLBACK_RETRY_MINUTES', 15), retryMaxMinutes: number('self_awake', 'AGENT_FALLBACK_RETRY_MAX_MINUTES', 720),
    memoReconcileSeconds: number('memo', 'RECONCILE_SECONDS', 30), memoBatchSize: number('memo', 'DISPATCH_BATCH_SIZE', 100, 1, 100),
    memoRetryMinutes: number('memo', 'DELIVERY_RETRY_MINUTES', 5),
    selfAwakeEnabled: bool('ENABLED', true), startupWakeEnabled: bool('STARTUP_WAKE_ENABLED', true),
    startupDelaySeconds: number('self_awake', 'STARTUP_WAKE_DELAY_SECONDS', 2, 0) }
}
export function ownsLocalCapabilities(workspaceRoot: string | undefined, dataRoot: string, env: NodeJS.ProcessEnv): boolean {
  if (env.EDEN_AGENT_OS_ROOT) return true
  if (!workspaceRoot) return false
  if (env.MON_WORKSPACE_ROOT) return true
  const relative = path.relative(workspaceRoot, dataRoot)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
export function workspaceForLocalCapabilities(workspaceRoot: string | undefined, dataRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  return ownsLocalCapabilities(workspaceRoot, dataRoot, env) ? workspaceRoot : undefined
}
function productVersion(workspaceRoot: string | undefined): string {
  const filename = workspaceRoot && path.join(workspaceRoot, 'VERSION')
  return filename && existsSync(filename) ? readFileSync(filename, 'utf8').trim() : 'development'
}

function legacyRoot(workspaceRoot: string): string | undefined {
  const integrated = path.join(workspaceRoot, 'Config', 'Os')
  if (existsSync(path.join(integrated, '.monconfig'))) return integrated
  const registry = path.join(workspaceRoot, '.monworkspace')
  if (existsSync(registry)) {
    const value = JSON.parse(readFileSync(registry, 'utf8')) as { modules?: { id: string; root: string }[] }
    const module = value.modules?.find(m => m.id === 'baseos')
    if (module) return path.resolve(workspaceRoot, module.root)
  }
  const root = path.join(workspaceRoot, 'BaseOs')
  return existsSync(path.join(root, '.monconfig')) ? root : undefined
}

function ini(text: string): Map<string, string> {
  const values = new Map<string, string>(); let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s[;#].*$/, '').trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (/^\[.+\]$/.test(line)) { section = line.slice(1, -1).toLowerCase(); continue }
    const equals = line.indexOf('=')
    if (equals < 1) throw new Error('OS 配置必须使用 KEY=VALUE')
    values.set(`${section}.${line.slice(0, equals).trim().toUpperCase()}`, line.slice(equals + 1).trim())
  }
  return values
}
