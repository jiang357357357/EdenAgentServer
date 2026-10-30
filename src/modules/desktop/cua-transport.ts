import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import type { JsonValue } from '@eden/api'
import { DesktopError } from './contracts.ts'
import { cuaOperationTimeout } from './cua-timeout.ts'

declare const EDEN_BUNDLED_SERVER: boolean
const envelope = z.object({ id: z.string().optional(), ready: z.boolean().optional(), backend: z.string().optional(), result: z.unknown().optional(),
  error: z.union([z.string(), z.object({ code: z.string().regex(/^[A-Za-z0-9_]+$/), message: z.string(),
    outcome: z.enum(['failed', 'cancelled', 'unknown']), diagnostics: z.record(z.string(), z.unknown()).optional() })]).optional() }).strict()
function launchWorker() {
  const bundled = typeof EDEN_BUNDLED_SERVER !== 'undefined'
  const entry = fileURLToPath(new URL(bundled ? './cua-worker.mjs' : './cua-worker.ts', import.meta.url))
  return spawn(process.execPath, [...(bundled ? [] : ['--import', 'tsx']), entry],
    { windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
}
function startupFailure(error: NonNullable<z.infer<typeof envelope>['error']>): Error {
  return typeof error === 'string' ? new Error('Cua 协议请求被拒绝') : new DesktopError(error.message, error.code, error.outcome)
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; input: boolean }
export class CuaTransport {
  private child: ChildProcessWithoutNullStreams | undefined
  private starting: Promise<number> | undefined
  private generation = 0
  private closed = false
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly launch = launchWorker) {}
  async prepare(signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    if (this.closed) throw new DesktopError('Cua 已关闭', 'CUA_CLOSED')
    if (this.child && !this.starting) return this.generation
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    const generation = await this.starting; signal.throwIfAborted(); return generation
  }
  private start(): Promise<number> {
    const child = this.launch(); this.child = child
    return new Promise((resolve, reject) => {
      let ready = false, remainder = ''
      const decoder = new StringDecoder('utf8')
      const deadline = setTimeout(() => failed(new DesktopError('Cua 启动超时', 'CUA_START_TIMEOUT')), 5000)
      const failed = (error: Error) => {
        clearTimeout(deadline)
        if (this.child !== child) return
        this.child = undefined
        if (!ready) reject(error)
        for (const waiter of this.pending.values()) waiter.reject(new DesktopError(error.message, 'CUA_DISCONNECTED', waiter.input ? 'unknown' : 'failed'))
        this.pending.clear(); child.kill()
      }
      child.stdout.on('data', bytes => {
        remainder += decoder.write(bytes)
        if (remainder.length > 32 * 1024 * 1024) { failed(new Error('Cua 响应过长')); return }
        let end: number
        while ((end = remainder.indexOf('\n')) >= 0) {
          const line = remainder.slice(0, end); remainder = remainder.slice(end + 1)
          try {
            const value = envelope.parse(JSON.parse(line))
            if (value.ready) {
              if (ready || value.backend !== 'eden.cua-driver.0.28.0') throw new Error('Unexpected Cua backend')
              ready = true; clearTimeout(deadline); resolve(++this.generation)
            }
            else if (value.id) {
              const waiter = this.pending.get(value.id); this.pending.delete(value.id)
              if (value.error) {
                const code = typeof value.error === 'string' ? value.error : value.error.code
                waiter?.reject(new DesktopError(typeof value.error === 'string' ? 'Cua 协议失败' : value.error.message,
                  code, typeof value.error === 'string' ? waiter?.input ? 'unknown' : 'failed' : value.error.outcome,
                  typeof value.error === 'string' ? undefined : value.error.diagnostics as Record<string, JsonValue> | undefined))
              } else waiter?.resolve(value.result)
            } else if (value.error) failed(startupFailure(value.error))
          } catch { failed(new Error('Cua 返回无效协议数据')); return }
        }
      })
      child.on('error', failed); child.on('exit', () => failed(new Error('Cua 后端已退出')))
      child.stdin.on('error', failed); child.stderr.resume()
    })
  }
  async request(action: string, args: Record<string, unknown>, signal: AbortSignal, input = false, scope = 'shared'): Promise<unknown> {
    if (action === 'release' && !this.child) return {}
    await this.prepare(signal)
    const child = this.child!
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined
      const deadline = setTimeout(() => abort(), cuaOperationTimeout(String(args.name ?? action), args.input as Record<string, unknown> ?? {}))
      const abort = () => {
        if (grace) return
        child.stdin.write(JSON.stringify({ action: 'cancel', requestId: id }) + '\n')
        grace = setTimeout(() => { child.kill(); finish(new DesktopError('Cua 取消未确认，请先观察', 'CUA_CANCEL_UNCONFIRMED', input ? 'unknown' : 'cancelled')) }, 7000)
      }
      const cleanup = () => { clearTimeout(deadline); if (grace) clearTimeout(grace); signal.removeEventListener('abort', abort); this.pending.delete(id) }
      const finish = (error: Error) => { cleanup(); reject(error) }
      this.pending.set(id, { input, resolve: value => { cleanup(); resolve(value) }, reject: finish })
      signal.addEventListener('abort', abort, { once: true })
      child.stdin.write(JSON.stringify({ id, action, args, scope }) + '\n')
      if (signal.aborted) abort()
    })
  }
  async close() {
    this.closed = true
    const child = this.child
    if (!child) return
    await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 4000); child.once('exit', () => { clearTimeout(timer); resolve() }); child.stdin.end() })
  }
  terminate() { this.closed = true; this.child?.kill() }
}
