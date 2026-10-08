import { MonHttpError } from '@eden/integrations'
import { ZodError } from 'zod'

export type SelfAwakeStage = 'request_body' | 'request_json' | 'submission_validation' | 'status_validation'
  | 'owner_identity' | 'status_lookup' | 'idempotency' | 'service_token' | 'assistant_fetch'
  | 'assistant_profile' | 'session_create' | 'model_catalog' | 'job_persist' | 'session_cleanup'
  | 'authorization' | 'service_availability' | 'request_limit' | 'request_method'
  | 'submission_processing' | 'status_processing' | 'response_serialization'

export class SelfAwakeStageError extends Error {
  cleanupFailed = false
  constructor(readonly stage: SelfAwakeStage, cause: unknown) {
    super(`Self-awake failed during ${stage}`, { cause })
    this.name = 'SelfAwakeStageError'
  }
}

export function selfAwakeStage<T>(stage: SelfAwakeStage, action: () => T): T {
  try { return action() }
  catch (error) { throw new SelfAwakeStageError(stage, error) }
}

export async function selfAwakeStageAsync<T>(stage: SelfAwakeStage, action: () => Promise<T>): Promise<T> {
  try { return await action() }
  catch (error) { throw new SelfAwakeStageError(stage, error) }
}

export interface SelfAwakeFailure {
  stage: SelfAwakeStage
  code: string
  errorName: string
  upstreamStatus?: number
  systemCode?: string
  schemaIssues?: { path: string; code: string }[]
  networkCodes?: string[]
  stackFrames?: string[]
  cleanupFailed?: boolean
}

/** Only fixed classifications and schema paths enter diagnostics; never log exception text or payloads. */
export function selfAwakeFailure(error: unknown, fallback: SelfAwakeStage): SelfAwakeFailure {
  const stage = error instanceof SelfAwakeStageError ? error.stage : fallback
  const cause = error instanceof SelfAwakeStageError ? error.cause : error
  const name = cause instanceof Error ? cause.name : 'UnknownError'
  const errorName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
  const stackFrames = diagnosticStack(cause)
  const common = { stage, errorName, ...(stackFrames.length ? { stackFrames } : {}),
    ...(error instanceof SelfAwakeStageError && error.cleanupFailed ? { cleanupFailed: true } : {}) }
  return { ...common, ...failureKind(cause, errorName) }
}

function diagnosticStack(cause: unknown): string[] {
  return cause instanceof Error ? (cause.stack ?? '').split('\n').slice(1)
    .flatMap(line => {
      const frame = /((?:Server|packages)\/(?:src|dist)\/[A-Za-z0-9_./-]+:\d+:\d+|dist\/server\/[A-Za-z0-9_./-]+:\d+:\d+)/.exec(line)
      return frame ? [frame[1]!] : []
    }).slice(0, 4) : []
}

function failureKind(cause: unknown, errorName: string): Omit<SelfAwakeFailure, 'stage' | 'errorName'> {
  if (cause instanceof ZodError) return { code: 'invalid_schema',
    schemaIssues: cause.issues.slice(0, 8).map(issue => ({
      path: issue.path.map(part => ['user_id', 'schema_version', 'idempotency_key', 'event_id', 'context', 'job_id'].includes(String(part)) ? String(part) : '?').join('.').slice(0, 160),
      code: issue.code,
    })) }
  if (cause instanceof MonHttpError) return { code: 'core_http_error', upstreamStatus: cause.status }
  const message = cause instanceof Error ? cause.message : ''
  const service = /^Core service identity rejected \((\d{3})\)$/.exec(message)
  if (service) return { code: 'core_service_identity_rejected', upstreamStatus: Number(service[1]) }
  const network = /^Core (?:请求超时|请求已取消|连接失败)（([^）]+)）：/.exec(message)
  if (network) return { code: 'core_transport_error',
    networkCodes: network[1]!.split(', ').filter(code => /^[A-Z0-9_]{1,80}$/.test(code)).slice(0, 5) }
  const systemCode = diagnosticSystemCode(cause)
  return { code: knownFailures[message] ?? fallbackFailureCode(cause, errorName, systemCode),
    ...(systemCode ? { systemCode } : {}) }
}

const knownFailures: Record<string, string> = {
    'Self-awake user mismatch': 'user_mismatch',
    'Self-awake job owner mismatch': 'job_owner_mismatch',
    'Idempotency key was used with a different request': 'idempotency_conflict',
    'Selected Mon model is inactive': 'model_inactive',
    'Mon Core 当前没有可用的默认助手，请先在助手管理中设置。': 'assistant_not_configured',
    'Core 模型目录数据格式不兼容，请检查 Core 的模型配置。': 'model_catalog_schema',
    'Core service token response is empty': 'core_service_token_empty',
    'Core service token response is too large': 'core_service_token_too_large',
    'Core service identity user mismatch': 'core_service_user_mismatch',
}

function diagnosticSystemCode(cause: unknown): string | undefined {
  const rawCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  return typeof rawCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : undefined
}

function fallbackFailureCode(cause: unknown, errorName: string, systemCode: string | undefined): string {
  if (cause instanceof SyntaxError) return 'invalid_json'
  if (errorName === 'AbortError') return 'cancelled'
  return systemCode ? 'system_error' : 'unexpected_error'
}
