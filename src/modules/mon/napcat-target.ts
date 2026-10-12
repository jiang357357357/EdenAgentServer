import type { NapcatTarget } from './napcat-transport.ts'

export interface NapcatSessionTarget extends NapcatTarget { sessionId: string; botId?: string; discovery?: boolean }
