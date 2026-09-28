import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serviceSignature } from '@eden/integrations'
import type { SelfAwakeBridge } from '../../modules/self-awake/index.ts'
import { SelfAwakeStageError, selfAwakeFailure, selfAwakeStage, selfAwakeStageAsync } from '../../modules/self-awake/diagnostic.ts'
import type { SelfAwakeFailure, SelfAwakeStage } from '../../modules/self-awake/diagnostic.ts'
import { BodyError, readBlobBody } from './blob-body.ts'

const paths = ['/internal/self-awake/run', '/internal/self-awake/status']
function reply(response: ServerResponse, status: number, value: unknown) {
  if (!response.destroyed && !response.writableEnded && !response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

export class SelfAwakeHttp {
  private readonly tasks = new Map<Promise<void>, IncomingMessage>()
  private closed = false
  constructor(private readonly origin: 'mon' | 'local', private readonly bridge?: SelfAwakeBridge) {}

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    if (!paths.includes(request.url ?? '')) return false
    const requestId = randomUUID()
    response.setHeader('x-eden-request-id', requestId)
    const route = request.url === paths[1] ? 'status' : 'run'
    if (this.origin !== 'mon') { reply(response, 404, { error: 'Not found' }); return true }
    if (this.closed || !this.bridge) { this.fail(response, requestId, route, 503, 'service_availability', 'service_unavailable'); return true }
    if (request.method !== 'POST' || request.headers.origin) { this.fail(response, requestId, route, 403, 'request_method', 'service_requests_only'); return true }
    if (this.tasks.size >= 8) { this.fail(response, requestId, route, 429, 'request_limit', 'too_many_requests'); return true }
    const task = this.dispatch(request, response, requestId, route).catch(error => {
      const failure = selfAwakeFailure(error, route === 'run' ? 'submission_processing' : 'status_processing')
      const bodyError = error instanceof SelfAwakeStageError && error.cause instanceof BodyError ? error.cause : undefined
      if (bodyError) failure.code = bodyError.status === 413 ? 'body_too_large' : bodyError.status === 408 ? 'body_timeout' : 'body_interrupted'
      this.fail(response, requestId, route, bodyError?.status ?? 400, failure.stage, failure.code, failure)
    })
    this.tasks.set(task, request)
    void task.then(() => this.tasks.delete(task))
    return true
  }

  async close(): Promise<void> {
    this.closed = true
    const closing = this.bridge?.close()
    for (const request of this.tasks.values()) request.destroy()
    await closing
    await Promise.all(this.tasks.keys())
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse, requestId: string, route: 'run' | 'status'): Promise<void> {
    const body = await selfAwakeStageAsync('request_body', () => readBlobBody(request, 65536))
    if (this.closed) { this.fail(response, requestId, route, 503, 'service_availability', 'server_closing'); return }
    const authFailure = selfAwakeStage('authorization', () => this.authorize(request, body))
    if (authFailure) { this.fail(response, requestId, route, 401, 'authorization', authFailure); return }
    const raw: unknown = selfAwakeStage('request_json', () => JSON.parse(body.toString('utf8')))
    const value = request.url === paths[1] ? this.bridge!.readStatus(raw) : await this.bridge!.submit(raw)
    reply(response, 200, value)
  }

  private fail(response: ServerResponse, requestId: string, route: 'run' | 'status', status: number,
    stage: SelfAwakeStage, code: string, detail?: SelfAwakeFailure): void {
    const record = { event: 'self_awake.request_failed', time: new Date().toISOString(), pid: process.pid,
      requestId, route, httpStatus: status, stage, code,
      ...(detail?.errorName ? { errorName: detail.errorName } : {}),
      ...(detail?.upstreamStatus ? { upstreamStatus: detail.upstreamStatus } : {}),
      ...(detail?.systemCode ? { systemCode: detail.systemCode } : {}),
      ...(detail?.schemaIssues ? { schemaIssues: detail.schemaIssues } : {}),
      ...(detail?.networkCodes ? { networkCodes: detail.networkCodes } : {}),
      ...(detail?.stackFrames ? { stackFrames: detail.stackFrames } : {}),
      ...(detail?.cleanupFailed ? { cleanupFailed: true } : {}) }
    try { process.stderr.write(`${JSON.stringify(record)}\n`) } catch { /* diagnostics must not hide the HTTP failure */ }
    reply(response, status, { error: 'Self-awake request could not be processed', code: stage === 'authorization' ? 'authorization_failed' : code,
      stage, requestId, ...(detail?.upstreamStatus ? { upstreamStatus: detail.upstreamStatus } : {}) })
  }

  private authorize(request: IncomingMessage, body: Buffer): string | undefined {
    const header = (key: string) => typeof request.headers[key] === 'string' ? request.headers[key] as string : ''
    const timestamp = header('x-mon-service-timestamp'), nonce = header('x-mon-service-nonce'), signature = header('x-mon-service-signature')
    if (header('x-mon-service-id') !== 'monos' || header('x-mon-service-scope') !== 'self_awake:submit') return 'invalid_service_identity'
    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return 'invalid_timestamp'
    if (!nonce || nonce.length > 128 || !/^[0-9a-fA-F]{64}$/.test(signature)) return 'invalid_signature_fields'
    const expected = serviceSignature(this.bridge!.identity.secret, 'monos', 'self_awake:submit', timestamp, nonce, request.url!, body)
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return 'invalid_signature'
    try { this.bridge!.repository.consumeNonce(nonce, Date.now() + 600000); return undefined }
    catch (error) {
      if (error instanceof Error && error.message === 'Service nonce capacity reached') return 'nonce_capacity_reached'
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT') ? 'nonce_replayed' : 'nonce_storage_error'
    }
  }
}
