import { MonHttpError } from '@eden/integrations'
import { redactCredentialText } from '@eden/api'

/** Only diagnostic fields; never stringify a recipient, provider receipt or request. */
export function contactFailureReason(value: unknown): string | undefined {
  if (value instanceof MonHttpError) {
    const detail = contactFailureReason(value.response)
    return `Core HTTP ${value.status}${detail ? `：${detail}` : ''}`
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const details = ['message', 'detail', 'error', 'code'].flatMap(key => {
    const text = record[key]
    return typeof text === 'string' ? [redactCredentialText(text).replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏凭据]').slice(0, 500)] : []
  })
  return [...new Set(details)].join('；').slice(0, 1200) || undefined
}

