import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OsTools, OsScheduler } from '../modules/os/index.ts'
import type { OsConfig, OsTarget } from '../modules/os/index.ts'
import { OsMcpEndpoint } from '../transport/http/os-mcp.ts'
import { migrateOsAccountState } from './os-account-state.ts'

/** One installation listener, owned by the same process as the account host, never by each account. */
export async function openOsRuntime(config: OsConfig, target: OsTarget) {
  let tools: OsTools | undefined, endpoint: OsMcpEndpoint | undefined, scheduler: OsScheduler | undefined
  const started = Date.now()
  const http = createServer((request, response) => {
    if (!tools || !endpoint || !scheduler) { response.writeHead(503).end(); return }
    if (request.url === config.mcpPath) { endpoint.handle(request, response); return }
    if (request.method === 'GET' && request.url === '/__ping') { response.writeHead(200).end('pong'); return }
    if (request.method === 'GET' && request.url === '/health') {
      const model = tools.recall.embedding.health(), schedule = !scheduler.fault
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        status: model && schedule ? 'ok' : 'degraded', service: 'Agent.os', owner: 'eden-agent-ts', pid: process.pid,
        uptime_seconds: Math.floor((Date.now() - started) / 1000), calls_total: tools.calls, calls_failed: tools.failures,
        model_runtime: model ? 'ok' : 'unavailable', model_backend: 'onnxruntime-node', scheduler: schedule ? 'ok' : 'degraded',
        self_awake_state: scheduler.status })); return
    }
    response.writeHead(404).end()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(config.port, '127.0.0.1', () => { http.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    throw new Error(`Agent 无法接管本地能力端口 ${config.port}；请先停止旧 MonOs 服务`, { cause: error })
  }
  try {
    tools = new OsTools(config); endpoint = new OsMcpEndpoint(tools, config.componentVersion)
    scheduler = new OsScheduler(config, target, tools.core)
    migrateOsAccountState(config)
  } catch (error) {
    await new Promise<void>(resolve => http.close(() => resolve())); await tools?.close()
    throw new Error('Agent 本地能力初始化失败', { cause: error })
  }
  let closing: Promise<void> | undefined
  const activeTools = tools, activeEndpoint = endpoint, activeScheduler = scheduler
  return { port: (http.address() as AddressInfo).port, start: () => activeScheduler.start(), get fault() { return activeScheduler.fault },
    close(): Promise<void> { return closing ??= (async () => {
      // Reject new effects, then drain admitted operations before releasing storage.
      http.closeIdleConnections()
      const closed = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
      await activeScheduler.close(); await activeEndpoint.close(); http.closeAllConnections(); await closed; await activeTools.close()
    })() } }
}
