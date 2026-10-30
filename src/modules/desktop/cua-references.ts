import { randomBytes, randomInt } from 'node:crypto'
import { DesktopError } from './contracts.ts'

const kinds = new Map([['pid', 'app'], ['process_id', 'app'], ['processId', 'app'], ['owner_pid', 'app'],
  ['window_id', 'window'], ['windowId', 'window'], ['hwnd', 'window'], ['focused_window_id', 'window'],
  ['element_token', 'element'], ['elementToken', 'element']])
const privateFields = new Set(['snapshot_id', 'snapshotId', 'request_id', 'requestId', 'call_id', 'callId', 'transport_id',
  'transport_session', 'daemon_generation', 'runtime_id', 'runtimeId', 'capability_manifest_sha256'])
const containers = new Set(['apps', 'windows', 'window', 'elements', 'sessions', 'session_state', 'state', 'target', 'focused_window', 'cursor'])
let nextReference = randomInt(2 ** 40, 2 ** 45)

/** Numeric public references keep upstream schemas intact; they never expose native PID/HWND values. */
export class CuaReferences {
  private readonly forward = new Map<string, string | number>()
  private readonly backward = new Map<string, unknown>()
  private readonly snapshots = new Map<string, unknown>()
  clear() { this.forward.clear(); this.backward.clear(); this.snapshots.clear() }
  private publish(kind: string, value: unknown): string | number {
    const identity = `${kind}:${String(value)}`
    let reference = this.forward.get(identity)
    if (reference === undefined) {
      if (this.forward.size >= 20000) throw new DesktopError('Cua 引用数量超过限制，请结束本会话', 'CUA_REFERENCE_LIMIT')
      reference = kind === 'element' ? `cua-element-${randomBytes(8).toString('hex')}` : ++nextReference
      this.forward.set(identity, reference); this.backward.set(`${kind}:${reference}`, value)
    }
    return reference
  }
  private resolve(kind: string, value: unknown): unknown {
    const key = `${kind}:${String(value)}`
    if (!this.backward.has(key)) throw new DesktopError('Cua 引用不属于当前会话或已失效，请重新发现目标', 'CUA_REFERENCE_EXPIRED')
    return this.backward.get(key)
  }
  encode(input: unknown, key = ''): unknown {
    if (input === null || input === undefined) return input
    const kind = kinds.get(key)
    if (kind && (typeof input === 'string' || typeof input === 'number')) return this.resolve(kind, input)
    if (Array.isArray(input)) return input.map(item => this.encode(item))
    if (typeof input !== 'object') return input
    const output: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(input)) {
      if (privateFields.has(name)) throw new DesktopError('Cua 内部快照和追踪字段由宿主管理', 'CUA_INTERNAL_ARGUMENT')
      output[name] = kinds.has(name) || containers.has(name) ? this.encode(value, name) : value
    }
    this.attachSnapshot(output)
    return output
  }
  private attachSnapshot(output: Record<string, unknown>) {
    const window = output.window_id ?? output.windowId
    if (window !== undefined && (output.element_index !== undefined || output.element_token !== undefined)) {
      const snapshot = this.snapshots.get(String(window))
      if (snapshot === undefined) throw new DesktopError('使用控件前请重新观察该窗口', 'CUA_OBSERVATION_REQUIRED')
      output.snapshot_id = snapshot
    }
  }
  decode(input: unknown, key = ''): unknown {
    if (input === null || input === undefined) return input
    const kind = kinds.get(key)
    if (kind && (typeof input === 'number' || typeof input === 'string') && input !== 0 && input !== '') return this.publish(kind, input)
    if (Array.isArray(input)) return input.map(item => this.decode(item))
    if (typeof input !== 'object') return input
    const object = input as Record<string, unknown>, window = object.window_id ?? object.windowId
    if (window !== undefined && (object.snapshot_id !== undefined || object.snapshotId !== undefined))
      this.snapshots.set(String(window), object.snapshot_id ?? object.snapshotId)
    return Object.fromEntries(Object.entries(object).filter(([name]) => !privateFields.has(name))
      .map(([name, value]) => [name, kinds.has(name) || containers.has(name) ? this.decode(value, name) : value]))
  }
}
