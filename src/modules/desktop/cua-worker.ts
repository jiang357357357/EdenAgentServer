import { createInterface } from 'node:readline'
import { z } from 'zod'
import { createNativeDriver } from './native-driver.ts'
import { DesktopError, type DesktopDriver, type NativeWindow } from './contracts.ts'
import { cuaCatalog } from './cua-catalog.ts'
import { CuaWorkerScopes } from './cua-worker-scopes.ts'
import { initializeCuaWorkerDpi } from './worker-dpi.ts'

const requestSchema = z.object({ id: z.string().min(1).max(80), scope: z.string().min(1).max(100), action: z.string(), args: z.record(z.string(), z.unknown()) }).strict()
try { initializeCuaWorkerDpi() }
catch {
  output({ error: { code: 'CUA_DPI_CONTEXT_UNAVAILABLE', message: 'Cua 工作进程无法建立物理像素 DPI 上下文，未启动桌面驱动', outcome: 'failed' } })
  process.exit(1)
}
const scopes = new CuaWorkerScopes(createNativeDriver)
const pending = new Map<string, AbortController>()
function output(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n') }
async function dispatch(driver: DesktopDriver, action: string, args: Record<string, unknown>, signal: AbortSignal) {
  if (action === 'prepare') return driver.prepare!(signal)
  if (action === 'windows') return driver.windows(signal)
  if (action === 'screen') return driver.screenSize!(signal)
  if (action === 'observe') return driver.observe(args.window as unknown as NativeWindow, signal,
    { screenshot: args.screenshot !== false, text: args.text !== false })
  if (action === 'act') return driver.act(String(args.name), args.input as Record<string, unknown>, signal)
  if (action === 'native') return driver.native!(String(args.name), args.input as Record<string, unknown>, signal)
  throw new DesktopError('Cua worker 操作未登记', 'CUA_WORKER_ACTION_INVALID')
}
async function execute(raw: unknown) {
  const request = requestSchema.parse(raw), controller = new AbortController()
  if (pending.has(request.id)) throw new Error('Duplicate Cua request')
  pending.set(request.id, controller)
  try {
    const result = request.action === 'catalog' ? cuaCatalog : request.action === 'release' ? await scopes.release(request.scope)
      : await scopes.run(request.scope, controller, driver => dispatch(driver, request.action, request.args, controller.signal))
    output({ id: request.id, result: result ?? {} })
  }
  catch (error) {
    const failure = error instanceof DesktopError ? error : new DesktopError('Cua 原生调用未确认', 'CUA_NATIVE_FAILED', 'unknown')
    output({ id: request.id, error: { code: failure.code, message: failure.message, outcome: failure.toolOutcome,
      ...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}) } })
  } finally { pending.delete(request.id) }
}
output({ ready: true, backend: 'eden.cua-driver.0.28.0' })
for await (const line of createInterface({ input: process.stdin })) {
  try {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Cua request too large')
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.action === 'cancel') pending.get(String(value.requestId))?.abort(new DesktopError('Cua 调用已取消，输入结果可能未知，请先观察', 'CUA_CANCELLED', 'unknown'))
    else void execute(value).catch(() => { output({ error: 'CUA_WORKER_PROTOCOL_ERROR' }) })
  } catch { output({ error: 'CUA_WORKER_PROTOCOL_ERROR' }) }
}
for (const controller of pending.values()) controller.abort()
const shutdownDeadline = setTimeout(() => process.exit(1), 3500)
await scopes.close(); clearTimeout(shutdownDeadline)
