import path from 'node:path'
import { z } from 'zod'
import { schedulerStatus } from './scheduler-status.ts'

export function selfAwakeScopeState(stateFile: string, sessionId: string): string {
  return path.join(path.dirname(stateFile), 'sessions', z.uuid().parse(sessionId), 'state.json')
}

/** Older MonOs must reject session-owned timers instead of accepting them into its global queue. */
export function assertScopedScheduler(stateFile: string, role = false, expectedAccount?: string): void {
  const status = schedulerStatus(stateFile, true, role, expectedAccount)
  if (!['ready', 'paused', 'starting'].includes(status.status)) throw new Error(status.message)
}
