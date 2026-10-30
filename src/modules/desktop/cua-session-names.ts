import { createHash } from 'node:crypto'
import { DesktopError } from './contracts.ts'
import { parseCuaJson } from './cua-json.ts'

/** Public Cua labels are scoped to one Eden caller; native session identities remain private. */
export class CuaSessionNames {
  private readonly names = new Map<string, string>()
  constructor(private readonly current: string) { this.names.set(current, 'default') }
  resolve(label: unknown): string {
    if (label === undefined || label === 'default') return this.current
    if (typeof label !== 'string' || !label.length || label.length > 128) throw new DesktopError('Cua 会话名称无效', 'CUA_SESSION_INVALID')
    const native = `${this.current}-${createHash('sha256').update(label).digest('hex').slice(0, 16)}`
    this.names.set(native, label); return native
  }
  project(json: string, filterOwned = false): string {
    const project = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(project).filter(item => item !== undefined)
      if (!value || typeof value !== 'object') return value
      const object = value as Record<string, unknown>
      if (filterOwned && typeof object.session === 'string' && !this.names.has(object.session)) return undefined
      return Object.fromEntries(Object.entries(object).map(([key, item]) => [key,
        ['session', 'public_session', 'session_id'].includes(key) && typeof item === 'string' ? this.names.get(item) ?? item
          : ['sessions', 'session_state', 'state'].includes(key) ? project(item) : item]))
    }
    return JSON.stringify(project(parseCuaJson(json)) ?? {})
  }
  text(value: string): string {
    for (const [native, label] of this.names) value = value.replaceAll(native, label)
    return value
  }
}
