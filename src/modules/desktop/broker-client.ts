import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { brokerPaths } from './broker-paths.ts'
import { jsonLines, send } from './framing.ts'
import { DesktopError } from './contracts.ts'
import { z } from 'zod'
import { jsonValue } from '@eden/api'
import { brokerOffline, registeredBroker } from './broker-connection.ts'
import { desktopBrokerProtocol } from './broker-registration.ts'
import { launchDesktopBroker } from './broker-process.ts'

interface ConnectionAttempt { start: boolean; work: Promise<void> }
interface BrokerClientOptions { launch?: (root: string) => void | Promise<void> }
const responseSchema = z.object({ id: z.string(), result: z.unknown().optional(), error: z.object({
  message: z.string(), code: z.string(), outcome: z.enum(['failed', 'cancelled', 'unknown']),
  diagnostics: z.record(z.string(), jsonValue).optional() }).optional() }).strict()
export class DesktopBrokerClient {
  private socket: Socket | undefined
  private connecting: ConnectionAttempt | undefined
  private closed = false
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  readonly paths: ReturnType<typeof brokerPaths>
  constructor(root?: string, private readonly options: BrokerClientOptions = {}) { this.paths = brokerPaths(root) }

  async connect(start: boolean): Promise<boolean> {
    if (this.closed) throw new DesktopError('桌面客户端已关闭')
    if (this.socket && !this.socket.destroyed && !this.connecting) return true
    const attempt = this.connecting ?? this.begin(start)
    try { await attempt.work; return true }
    catch (error) {
      if (brokerOffline(error)) {
        if (start && !attempt.start) return this.connect(true)
        if (!start) return false
      }
      throw error
    }
  }
  private begin(start: boolean): ConnectionAttempt {
    const attempt: ConnectionAttempt = { start, work: this.open(start).finally(() => {
      if (this.connecting === attempt) this.connecting = undefined
    }) }
    this.connecting = attempt; return attempt
  }
  private async open(start: boolean): Promise<void> {
    let launched = false, last: unknown
    const deadline = Date.now() + (start ? 10000 : 1000)
    do {
      try {
        if (this.closed) throw new DesktopError('桌面客户端已关闭')
        const { socket, token } = await registeredBroker(this.paths)
        if (this.closed) { socket.destroy(); throw new DesktopError('桌面客户端已关闭') }
        this.attach(socket)
        const hello = await this.request({ type: 'hello', token, protocol: desktopBrokerProtocol }, AbortSignal.timeout(2000))
        if (!z.object({ protocol: z.literal(desktopBrokerProtocol) }).safeParse(hello).success)
          throw new DesktopError('桌面服务未确认当前协议，未继续操作', 'BROKER_HANDSHAKE_INVALID')
        return
      } catch (error) {
        last = error; this.socket?.destroy(); this.socket = undefined
        if (this.closed || !start) throw error
        if (brokerOffline(error)) {
          if (!launched) { await (this.options.launch ?? launchDesktopBroker)(this.paths.root); launched = true }
        } else if (!(error instanceof DesktopError && error.code === 'BROKER_REGISTRATION_PENDING')) throw error
        await new Promise<void>(resolve => setTimeout(resolve, 150))
      }
    } while (Date.now() < deadline)
    throw new DesktopError(`桌面服务无法启动：${last instanceof DesktopError ? last.message : '请构建桌面驱动后重试'}`, 'BROKER_UNAVAILABLE')
  }
  private attach(socket: Socket) {
    this.socket = socket
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      for (const waiter of this.pending.values()) waiter.reject(new DesktopError('桌面连接中断；输入可能已发生，禁止自动重放', 'DESKTOP_DISCONNECTED', 'unknown'))
      this.pending.clear()
    })
    jsonLines(socket, 32 * 1024 * 1024, value => {
      const reply = responseSchema.parse(value), waiter = this.pending.get(reply.id)
      this.pending.delete(reply.id)
      if (reply.error) waiter?.reject(new DesktopError(reply.error.message, reply.error.code, reply.error.outcome, reply.error.diagnostics))
      else waiter?.resolve(reply.result)
    })
  }
  request(message: Record<string, unknown>, signal: AbortSignal = AbortSignal.timeout(120000)): Promise<unknown> {
    signal.throwIfAborted()
    const socket = this.socket
    if (!socket || socket.destroyed) throw new DesktopError('桌面控制尚未连接')
    const id = randomUUID()
    const envelope = { ...message, id }
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 128 * 1024)
      throw new DesktopError('桌面指令过长，请分批输入或减少启动参数', 'DESKTOP_REQUEST_TOO_LARGE')
    return new Promise((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        if (socket.destroyed) return
        send(socket, { id: randomUUID(), type: 'cancel', requestId: id })
        grace = setTimeout(() => { socket.destroy(); reject(new DesktopError('取消后未能确认输入停止，结果未知', 'CANCEL_UNCONFIRMED', 'unknown')) }, 10000)
      }
      const cleanup = () => { signal.removeEventListener('abort', abort); if (grace) clearTimeout(grace) }
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } })
      signal.addEventListener('abort', abort, { once: true })
      try { send(socket, envelope); if (signal.aborted) abort() }
      catch (error) { this.pending.delete(id); cleanup(); reject(error) }
    })
  }
  close() { this.closed = true; this.socket?.destroy() }
}
