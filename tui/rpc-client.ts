import WebSocket from 'ws'
import { protocolVersion, rpcMethods, sessionEventSchema, tokenProtocolPrefix, websocketProtocol } from '@eden/api'
import type { RuntimeOrigin, SchemaRpcMethodMap, SessionEvent } from '@eden/api'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; parse(value: unknown): unknown; timer: ReturnType<typeof setTimeout> }

/** The TUI has its own connection. It never opens a database or starts an Agent runtime. */
export class TuiRpcClient {
  private socket: WebSocket | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly events = new Set<(event: SessionEvent) => void>()
  private readonly closed = new Set<() => void>()

  onEvent(listener: (event: SessionEvent) => void): void { this.events.add(listener) }
  onClose(listener: () => void): void { this.closed.add(listener) }

  async connect(origin: RuntimeOrigin, port: number, capability: string, core?: string): Promise<void> {
    if (this.socket) throw new Error('RPC 已连接')
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [websocketProtocol, `${tokenProtocolPrefix}${capability}`], { handshakeTimeout: 10_000 })
    this.socket = socket
    socket.on('message', (data, binary) => { if (this.socket === socket && !binary) this.receive(data.toString()) })
    socket.on('close', () => this.disconnect(socket))
    socket.on('error', () => this.disconnect(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('连接 Agent Server 超时')) }, 10_000)
        const open = () => { cleanup(); resolve() }
        const fail = () => { cleanup(); reject(new Error('连接 Agent Server 失败；检查端口和能力令牌')) }
        const cleanup = () => { clearTimeout(timeout); socket.off('open', open); socket.off('error', fail); socket.off('close', fail) }
        socket.once('open', open); socket.once('error', fail); socket.once('close', fail)
      })
      await this.request('initialize', { protocolVersion, runtimeOrigin: origin, clientName: 'eden-agent-tui',
        clientVersion: '1', capabilities: ['session-events'], ...(core ? { coreToken: core } : {}) })
    } catch (error) { this.close(); throw error }
  }

  request<K extends keyof SchemaRpcMethodMap>(method: K, params: SchemaRpcMethodMap[K]['params']): Promise<SchemaRpcMethodMap[K]['result']> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('RPC 已断开'))
    if (this.pending.size >= 48) return Promise.reject(new Error('RPC 请求过多'))
    if (!Number.isSafeInteger(this.nextId)) return Promise.reject(new Error('RPC 请求编号已耗尽；请重连'))
    const contract = rpcMethods[method], id = this.nextId++
    const input = contract.params.parse(params)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${String(method)} 超时；执行结果未确认，重试前请查看历史`))
      }, 120_000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, parse: value => contract.result.parse(value), timer })
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: input })) }
      catch {
        clearTimeout(timer); this.pending.delete(id)
        reject(new Error('RPC 发送失败；执行结果未确认'))
      }
    })
  }

  close(): void {
    const socket = this.socket
    if (!socket) return
    this.disconnect(socket)
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'TUI closed')
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).jsonrpc !== '2.0') return
      message = value as Record<string, unknown>
    } catch { return }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.error && typeof message.error === 'object') {
        const error = message.error as { message?: unknown }
        pending.reject(new Error(typeof error.message === 'string' ? error.message : 'RPC 请求失败'))
      } else {
        try { pending.resolve(pending.parse(message.result)) }
        catch { pending.reject(new Error('RPC 响应与协议不一致')) }
      }
      return
    }
    if (message.method !== 'session.event') return
    const event = sessionEventSchema.safeParse(message.params)
    if (event.success) for (const listener of this.events) listener(event.data)
  }

  private disconnect(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('RPC 连接断开；未完成请求的结果不确定'))
    }
    this.pending.clear()
    for (const listener of this.closed) listener()
  }
}
