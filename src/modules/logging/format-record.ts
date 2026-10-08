import { safeLogText } from './redaction.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogOrigin = 'mon' | 'local'
export type DiagnosticRecord = Record<string, unknown> & { event: string; level: LogLevel; time: string; pid: number; origin?: LogOrigin }

const levels = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' } as const
const colors = { debug: 90, info: 36, warn: 33, error: 31 } as const
const events: Record<string, string> = {
  'server.startup': '服务启动', 'server.listening': '服务已就绪', 'server.account.failure': '账号启动失败',
  'server.workspace.unavailable': '工作区暂不可用', 'server.shutdown': '服务正在关闭',
  'server.shutdown.complete': '服务已关闭', 'server.shutdown.failed': '服务关闭失败',
  'server.stopping': '服务正在关闭', 'server.stopped': '服务已关闭',
  'server.shutdown.timeout': '服务关闭超时', 'server.startup.failed': '服务启动失败',
  'logging.file_failed': '日志文件写入失败，继续使用控制台',
  'node.warning': 'Node.js 运行提示', 'sqlite.experimental_warning': 'SQLite 实验性功能提示',
  'process.warning': 'Node.js 运行提示',
  'self_awake.request_failed': '自主唤醒请求失败',
}
const stages: Record<string, string> = {
  'legacy.database': '检查旧数据库', 'legacy.ownership': '核对历史会话归属',
  'account.metadata': '准备账号信息', 'account.import': '导入账号分区',
  'account.services': '初始化账号服务', 'account.background': '启动账号后台任务',
  'account.resume': '恢复账号运行时', 'account.ready': '账号已就绪',
}
const fields: Record<string, string> = { account: '账号', path: '路径', host: '地址', port: '端口',
  method: '方法', status: '状态', errorCode: '错误码', code: '代码', warningName: '警告类型',
  sessionId: '会话', jobId: '任务', connectorId: '连接器' }

export function logUsesColor(env: NodeJS.ProcessEnv, tty: boolean): boolean {
  if (Object.hasOwn(env, 'NO_COLOR')) return false
  if (Object.hasOwn(env, 'FORCE_COLOR')) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  return tty
}

function errorSummary(value: unknown): string {
  if (typeof value === 'string') return safeLogText(value, 500)
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  return errorSummary(item.message) || errorSummary(item.cause)
}

/** The console intentionally prints only named diagnostic fields, never every record property. */
export function formatDiagnostic(record: DiagnosticRecord, color = false): string {
  const date = new Date(record.time)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  const world = record.origin === 'mon' ? 'Agent/伊甸园' : record.origin === 'local' ? 'Agent/尘世' : 'Agent'
  const label = `[${levels[record.level]}]`
  const level = color ? `\x1b[${colors[record.level]}m${label}\x1b[0m` : label
  const title = events[record.event] ?? `运行诊断（${safeLogText(record.event, 120)}）`
  const stage = typeof record.stage === 'string' ? ` · ${stages[record.stage] ?? safeLogText(record.stage, 120)}` : ''
  const details = Object.entries(fields).flatMap(([key, name]) => {
    const value = record[key]
    return typeof value === 'string' || typeof value === 'number' ? [`${name}=${safeLogText(String(value), 500)}`] : []
  })
  const businessMessage = errorSummary(record.message), error = errorSummary(record.error)
  const message = [businessMessage, error !== businessMessage ? error : ''].filter(Boolean).join('；')
  return `[${time}] ${level} [${world}] ${title}${stage}${details.length ? ` | ${details.join(' ')}` : ''}${message ? ` | ${message}` : ''}\n`
}
