import path from 'node:path'
import { configureLogging, logDiagnostic } from './modules/logging/index.ts'
import { installProcessDiagnostics } from './bootstrap/process-diagnostics.ts'
import { installShutdown } from './bootstrap/shutdown.ts'

// Establish diagnostics before loading the runtime (and node:sqlite), including startup failures.
const origin = process.env.EDEN_AGENT_RUNTIME_ORIGIN === 'mon' ? 'mon' : 'local'
const removeDiagnostics = installProcessDiagnostics()
const logging = configureLogging({ origin, dataRoot: path.resolve(process.env.EDEN_AGENT_DATA_ROOT
  ?? path.join(process.cwd(), 'Data', 'realms', origin)) })
process.once('exit', () => { logging.close(); removeDiagnostics() })

try {
  const { loadConfig } = await import('./bootstrap/config.ts')
  const config = loadConfig()
  const { startServer } = await import('./bootstrap/container.ts')
  const server = await startServer(config)
  installShutdown(server)
  logDiagnostic({ event: 'server.listening', origin: config.origin, host: config.host, port: server.port,
    workspaceId: config.workspaceId, mode: 'runtime' })
  if (process.connected && process.send) process.send({ type: 'eden-agent.ready', origin: config.origin,
    host: config.host, port: server.port, pid: process.pid }, error => {
    if (error) logDiagnostic({ event: 'server.ready.notify_failed', message: '无法向父进程报告启动状态', error: error.message }, 'warn')
  })
} catch (error) {
  logDiagnostic({ event: 'server.startup.failed', message: '服务启动失败',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error ? { stack: error.stack } : {}) }, 'error')
  // A failed startup may still own handles; preserve the CLI's fatal-exit semantics.
  process.exit(1)
}
