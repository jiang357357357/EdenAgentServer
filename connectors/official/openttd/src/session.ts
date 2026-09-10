import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { jsonValue } from '@eden/api/connector'
import type { JsonValue } from '@eden/api/connector'
import type { ConnectorContext, ConnectorCall, ConnectorSession } from '@eden/plugin-sdk/connector'
import { PacketFrames, PacketReader, packet, cstring, subscriptions, pollPackets } from './packets.ts'
import { GameState, decodeState } from './state.ts'
import { serverAction } from './actions.ts'

function object(raw: JsonValue | undefined): Record<string, JsonValue> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected command object')
  return raw
}
export class AdminSession implements ConnectorSession {
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private readonly socket: Socket
  private readonly state: GameState
  private readonly pending = new Map<string, { resolve(value: JsonValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private failed = false
  private sequence = 0
  constructor(private readonly context: ConnectorContext) {
    const settings = object(context.settings), password = process.env.MON_CONNECTOR_IDENTITY_CREDENTIAL
    const socketPath = process.env.EDEN_CONNECTOR_NETWORK_SOCKET
    if (!password || !socketPath) throw new Error('OpenTTD credential or approved bridge missing')
    if (settings.adminPort === (settings.gamePort ?? 3979)) throw new Error('Game and admin ports must differ')
    this.signal = AbortSignal.any([context.signal, this.abort.signal])
    this.state = new GameState({ instance_id: process.env.MON_CONNECTOR_IDENTITY_KEY ?? '', host: settings.host ?? '', admin_port: settings.adminPort ?? null,
      game_port: settings.gamePort ?? 3979, pid: 0, mode: 'configured', started_at: '' })
    this.socket = connect({ path: socketPath, signal: this.signal })
    const frames = new PacketFrames()
    this.socket.on('connect', () => this.send(packet(0, Buffer.concat([cstring(password), cstring('Eden Agent'), cstring('1')]))))
    this.socket.on('data', bytes => { try { frames.push(bytes, (type, body) => this.receive(type, body)) } catch { this.fail() } })
    this.socket.on('error', () => this.fail())
    this.socket.on('close', () => { if (!this.signal.aborted) this.fail() })
    this.socket.setTimeout(30000, () => { const body = Buffer.alloc(4); body.writeUInt32LE(++this.sequence >>> 0); this.send(packet(7, body)) })
  }
  health() { return { state: this.failed ? 'degraded' as const : this.state.authenticated ? 'ready' as const : 'connecting' as const, initialized: true } }
  private send(bytes: Buffer) {
    this.signal.throwIfAborted()
    if (this.socket.writableLength > 1024 * 1024) throw new Error('OpenTTD send queue exceeds limit')
    this.socket.write(bytes)
  }
  private fail() {
    if (this.failed || this.signal.aborted) return
    this.failed = true
    try { this.context.status('degraded') } finally { this.abort.abort(); this.rejectPending() }
  }
  private rejectPending() {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('OpenTTD connection closed; remote outcome may be unknown')) }
    this.pending.clear()
  }
  private receive(type: number, body: Buffer) {
    if (type === 102) throw new Error('OpenTTD rejected connection or command')
    if (type === 103) {
      const negotiated = subscriptions(body)
      for (const bytes of negotiated.packets) this.send(bytes)
      this.state.server.admin_protocol_version = negotiated.version; this.state.authenticated = true
      this.context.status('ready'); this.poll(); this.probe(); return
    }
    if (type === 124) { this.gamescript(new PacketReader(body).string()); return }
    const event = decodeState(type, body, this.state)
    if (event) this.context.publish(event.type, `openttd:${randomUUID()}`, event.payload)
    if (type === 105) this.probe()
  }
  private gamescript(raw: string) {
    let message: JsonValue = raw
    try { message = jsonValue.parse(JSON.parse(raw)) } catch { /* Non-JSON script messages remain observable. */ }
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      if (message.type === 'bridge_ready' || message.type === 'command_result') this.state.bridgeReady = true
      if (typeof message.bridge_version === 'number') this.state.bridgeVersion = message.bridge_version
      if (typeof message.request_id === 'string') {
        const waiter = this.pending.get(message.request_id)
        if (waiter) { this.pending.delete(message.request_id); clearTimeout(waiter.timer); waiter.resolve(message) }
      }
      if (['bridge_ready', 'command_result', 'heartbeat', 'state'].includes(String(message.type))) return
    }
    this.context.publish('gamescript', `openttd:${randomUUID()}`, { message })
  }
  private poll() { for (const bytes of pollPackets()) this.send(bytes) }
  private probe() { this.state.bridgeReady = false; this.send(packet(6, cstring(JSON.stringify({ action: 'ping', request_id: `bridge-probe-${randomUUID()}` })))) }
  private async authenticated() {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10000)])
    while (!this.state.authenticated) await delay(20, undefined, { signal })
    this.signal.throwIfAborted()
  }
  async query(call: ConnectorCall): Promise<JsonValue> {
    if (call.capability === 'get_state') return this.execute({ ...call, capability: 'refresh_state' })
    return this.execute({ ...call, capability: 'gameplay_command', payload: { command: { ...object(call.payload), action: call.capability } } })
  }
  async execute(call: ConnectorCall): Promise<JsonValue> {
    await this.authenticated()
    if (call.capability === 'gameplay_command') {
      const result = object(await this.gameplay(object(object(call.payload).command)))
      return { ok: result.ok === true, action: call.capability, result }
    }
    if (call.capability === 'gameplay_plan') return this.plan(object(call.payload).commands)
    if (call.capability === 'refresh_state') { this.poll(); await delay(2000, undefined, { signal: this.signal }) }
    else this.send(serverAction(call.capability, call.payload))
    return { ok: true, action: call.capability, state: this.state.snapshot() }
  }
  private async plan(commands: JsonValue | undefined): Promise<JsonValue> {
    if (!Array.isArray(commands) || !commands.length || commands.length > 50) throw new Error('Plan requires 1..50 commands')
    const results: JsonValue[] = []
    for (const [index, command] of commands.entries()) {
      const result = object(await this.gameplay(object(command)))
      results.push({ index, command, result })
      if (result.ok !== true) return { ok: false, action: 'gameplay_plan', failed_at: index, results }
    }
    return { ok: true, action: 'gameplay_plan', results }
  }
  private gameplay(command: Record<string, JsonValue>): Promise<JsonValue> {
    if (!this.state.bridgeReady || typeof command.action !== 'string' || !command.action.trim()) throw new Error('GameScript bridge or command is unavailable')
    if (this.pending.size >= 32) throw new Error('GameScript request queue is full')
    const id = randomUUID().replaceAll('-', ''), bytes = packet(6, cstring(JSON.stringify({ ...command, request_id: id })))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('GameScript response timed out; remote outcome may be unknown')) }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send(bytes) } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }
  async close() {
    if (!this.socket.destroyed) { try { this.send(packet(1)) } catch { /* Socket may already be aborting. */ } }
    this.abort.abort(); this.rejectPending()
    if (!this.socket.closed) await new Promise<void>(resolve => this.socket.once('close', resolve))
  }
}
