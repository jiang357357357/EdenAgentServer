import { logDiagnostic } from '../modules/logging/index.ts'

/** Owns the CLI's warning presentation; other application warning observers remain installed. */
export function installProcessDiagnostics(): () => void {
  // Node 22 registers its standard printer as onWarning. Only replace that printer, not other observers.
  const printers = process.listeners('warning').filter(listener => listener.name === 'onWarning')
  for (const printer of printers) process.removeListener('warning', printer)
  const warning = (value: Error & { code?: string }) => {
    const sqlite = value.name === 'ExperimentalWarning' && /^SQLite is an experimental feature\b/.test(value.message)
    logDiagnostic({ event: 'process.warning', warningName: value.name, code: value.code,
      message: sqlite ? '当前 Node.js 内置 SQLite 接口带有实验性标记' : value.message,
      detail: value.message, stack: value.stack }, 'warn')
  }
  const uncaught = (error: Error, source: string) => {
    logDiagnostic({ event: 'process.uncaught_exception', message: '服务遇到未处理异常，即将退出',
      source, error: error.message, stack: error.stack }, 'error')
  }
  process.on('warning', warning)
  // Monitor preserves Node's failure exit behavior; it does not handle or swallow the exception.
  process.on('uncaughtExceptionMonitor', uncaught)
  let active = true
  return () => {
    if (!active) return
    active = false
    process.removeListener('warning', warning)
    process.removeListener('uncaughtExceptionMonitor', uncaught)
    for (const printer of printers) process.on('warning', printer)
  }
}
