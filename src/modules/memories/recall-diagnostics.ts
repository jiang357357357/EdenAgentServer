import { OperationFailure } from '@eden/api'

const coreReasons = new Set(['model_missing', 'model_configuration_invalid', 'embedding_unavailable', 'invalid_threshold'])

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'UnknownError'
}

function coreFacts(error: OperationFailure) {
  const { status, reason } = error.details
  const details = reason && typeof reason === 'object' && !Array.isArray(reason) ? reason : undefined
  const code = details?.reason
  return { ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof code === 'string' && coreReasons.has(code) ? { coreReason: code } : {}),
    endpoint: '/api/agent/memories/retrieve/' }
}

/** Only bounded failure facts belong in diagnostics; HTTP error text may contain private inputs. */
export function memoryRecallFailure(error: unknown, stage: 'retrieval' | 'selection') {
  const name = errorName(error)
  if (stage === 'selection') return { errorName: name, errorCode: 'invalid_selection' }
  if (name === 'TimeoutError') return { errorName: name, errorCode: 'retrieval_timeout' }
  if (name === 'AbortError') return { errorName: name, errorCode: 'retrieval_aborted' }
  if (!(error instanceof OperationFailure)) return { errorName: name, errorCode: name === 'ZodError' ? 'invalid_response' : 'retrieval_error' }
  return { errorName: name, errorCode: 'core_http_error', ...coreFacts(error) }
}
