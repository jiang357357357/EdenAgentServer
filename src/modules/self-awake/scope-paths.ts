import path from 'node:path'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export function selfAwakeScopeState(stateFile: string, sessionId: string): string {
  return path.join(path.dirname(stateFile), 'sessions', z.uuid().parse(sessionId), 'state.json')
}

/** Older MonOs must reject session-owned timers instead of accepting them into its global queue. */
export function assertScopedScheduler(stateFile: string, role = false): void {
  try {
    const value = JSON.parse(readFileSync(path.join(path.dirname(stateFile), 'session-protocol.json'), 'utf8'))
    if (value?.protocolVersion !== 2 || value?.sessionScopes !== true || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('unsupported')
    if (role && value.roleScopes !== true) throw new Error('unsupported role scopes')
  } catch { throw new Error('MonOs 尚未提供匹配的会话/角色调度协议，请先升级并启动匹配的 MonOs 服务') }
}
