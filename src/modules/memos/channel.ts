import type { JsonValue } from '@eden/api'

export interface MemoChannelReceipt {
  state: 'accepted' | 'failed' | 'unknown'
  receipt?: JsonValue
  error?: string
}

