import type { MonServiceIdentity } from '@eden/integrations'

/** Installation-owned capabilities are shared by Core; account runtimes retain their own databases. */
export interface OsConfig {
  root: string
  databasePath: string
  vectorDir: string
  legacyVectorDir: string
  modelPath: string
  wakeDir: string
  memoDir: string
  legacyWakeDir?: string | undefined
  legacyMemoDir?: string | undefined
  port: number
  mcpPath: string
  componentVersion: string
  identity: MonServiceIdentity | undefined
  controlSeconds: number
  pollSeconds: number
  retryMinutes: number
  retryMaxMinutes: number
  memoReconcileSeconds: number
  memoBatchSize: number
  memoRetryMinutes: number
  selfAwakeEnabled: boolean
  startupWakeEnabled: boolean
  startupDelaySeconds: number
}

export type State = Record<string, any>
export interface WakeTarget {
  run(payload: unknown): Promise<State>
  status(jobId: string, userId: string): Promise<State>
  ready(): boolean
}
export interface ReminderInput {
  key: string; sourceId: string; title: string; content: string; priority: 'low' | 'normal' | 'high'; at: number
}
export interface ReminderTarget {
  admitReminder(input: ReminderInput): Promise<{ memoId: number }>
  reminderDelivery(memoId: number): Promise<number | null>
}
export type OsTarget = WakeTarget & ReminderTarget

export function time(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}
export const iso = (timestamp = Date.now()): string => new Date(timestamp).toISOString()
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
