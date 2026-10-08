import { logDiagnostic } from '../modules/logging/index.ts'

export function installShutdown(server: { close(): Promise<void> }): void {
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    logDiagnostic({ event: 'server.stopping', message: '正在停止服务，等待任务和连接关闭' })
    const deadline = setTimeout(() => {
      logDiagnostic({ event: 'server.shutdown.timeout', message: '服务关闭超过 10 秒，强制退出' }, 'error')
      process.exit(1)
    }, 10_000)
    deadline.unref()
    void server.close().then(() => {
      clearTimeout(deadline)
      logDiagnostic({ event: 'server.stopped', message: '服务已停止' })
      if (process.connected) process.disconnect()
    }, error => {
      logDiagnostic({ event: 'server.shutdown.failed', message: '服务关闭失败',
        error: error instanceof Error ? error.message : String(error) }, 'error')
      process.exitCode = 1
      if (process.connected) process.disconnect()
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('message', message => { if (message === 'shutdown') shutdown() })
}
