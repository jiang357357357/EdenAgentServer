import { z } from 'zod'
import { createHash } from 'node:crypto'
import { desktopStatusSchema, jsonValue, toJson, type DesktopStatus, type JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { BlobService } from '../blobs/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { PermissionContext, PermissionService } from '../permissions/index.ts'
import { DesktopBrokerClient } from './broker-client.ts'
import { DesktopOperations } from './operation-repository.ts'
import { DesktopError } from './contracts.ts'
import { CUA_DESKTOP_GRANT } from '../../model-prompts/cua-tools.ts'

const responseSchema = z.object({ value: z.record(z.string(), jsonValue), images: z.array(z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict()).max(4).optional() }).strict()
const idle = (available: boolean): DesktopStatus => ({ available, busy: false, paused: false, stopped: false, observerAvailable: false, operations: [] })
export class DesktopService {
  private readonly client: DesktopBrokerClient
  private readonly operations: DesktopOperations
  private readonly grants = new Map<string, { mode: string; expiresAt: number; ready: Promise<void> }>()
  constructor(database: EdenDatabase, private readonly sessions: SessionRepository, private readonly blobs: BlobService, brokerRoot?: string,
    private readonly available = process.platform === 'win32') {
    this.client = new DesktopBrokerClient(brokerRoot); this.operations = new DesktopOperations(database)
  }
  async authorize(permissions: PermissionService, context: PermissionContext, actor?: string | number) {
    if (!this.available) throw new DesktopError('桌面控制当前仅支持 Windows', 'PLATFORM_UNSUPPORTED')
    this.assertSession(context.sessionId)
    const mode = permissions.mode(), key = `${context.sessionId}:${context.turnId}:${actor ?? 'root'}`
    let grant = this.grants.get(key)
    if (!grant || grant.mode !== mode || grant.expiresAt < Date.now()) {
      if (this.grants.size > 512) this.grants.clear()
      const ready = permissions.request(context, 'desktop.control', 'Windows 当前交互桌面', {
        scope: CUA_DESKTOP_GRANT, foreground: true, task: context.turnId, actor: actor ?? 'root',
      })
      grant = { mode, expiresAt: Date.now() + 15 * 60 * 1000, ready }; this.grants.set(key, grant)
      ready.catch(() => { if (this.grants.get(key) === grant) this.grants.delete(key) })
    }
    await grant.ready; context.signal.throwIfAborted(); context.assertCurrent?.()
  }
  async execute(name: string, input: Record<string, unknown>, context: PermissionContext, actor?: string | number): Promise<JsonValue> {
    this.assertSession(context.sessionId)
    if (!this.available) throw new DesktopError('桌面控制当前仅支持 Windows', 'PLATFORM_UNSUPPORTED')
    const id = `${context.turnId}:${context.callId}`
    this.operations.begin({ id, sessionId: context.sessionId, turnId: context.turnId, actor: String(actor ?? 'root'), action: name, request: toJson(input) })
    try {
      await this.client.connect(true)
      context.signal.throwIfAborted(); context.assertCurrent?.()
      const result = responseSchema.parse(await this.client.request({ type: 'execute', session: context.sessionId,
        context: executionScope(context.turnId, actor), name, input }, context.signal))
      const images = []
      for (const image of result.images ?? []) {
        context.signal.throwIfAborted()
        const bytes = Buffer.from(image.data, 'base64')
        if (bytes.toString('base64') !== image.data) throw new DesktopError('桌面图像编码无效')
        const blob = await this.blobs.put(bytes, image.mime)
        images.push({ blobId: blob.id, mime: image.mime })
      }
      const value = toJson({ ...result.value, ...(images.length ? { images } : {}) })
      const status = result.value.status
      this.operations.finish(id, status === 'unknown' ? 'unknown' : status === 'refused' ? 'failed' : 'completed', value)
      return value
    } catch (error) {
      const outcome = error instanceof DesktopError ? error.toolOutcome : 'unknown'
      const message = error instanceof DesktopError ? error.message : '桌面结果未能确认，请先观察当前状态'
      const diagnostics = error instanceof DesktopError ? toJson({ code: error.code, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) }) : null
      this.operations.finish(id, outcome, diagnostics, message)
      throw error instanceof DesktopError ? error : new DesktopError(message, 'DESKTOP_RESULT_UNKNOWN', 'unknown')
    }
  }
  async images(result: JsonValue, signal?: AbortSignal) {
    if (confirmedAction(result)) return []
    const refs = z.object({ images: z.array(z.object({ blobId: z.string(), mime: z.string() })).optional() }).passthrough().parse(result)
    const images = []
    for (const ref of refs.images ?? []) {
      signal?.throwIfAborted()
      const { bytes, info } = await this.blobs.read(ref.blobId)
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(info.mime)) throw new Error('桌面图像类型无效')
      images.push({ type: 'image' as const, data: bytes.toString('base64'), mimeType: info.mime as 'image/png' | 'image/jpeg' | 'image/webp' })
    }
    return images
  }
  async status() {
    if (!this.available || !await this.client.connect(false)) return idle(this.available)
    return desktopStatusSchema.parse(await this.client.request({ type: 'status' }, AbortSignal.timeout(5000)))
  }
  async control(action: 'pause' | 'resume' | 'stop') {
    this.grants.clear()
    if (!await this.client.connect(false)) return idle(this.available)
    return desktopStatusSchema.parse(await this.client.request({ type: 'control', action }, AbortSignal.timeout(5000)))
  }
  private assertSession(sessionId: string) {
    const session = this.sessions.read(sessionId)
    if (session.sourceChannel === 'qq') throw new DesktopError('QQ 会话没有本机桌面控制授权', 'DESKTOP_CHANNEL_DENIED')
    const environment = session.environment
    if (environment && typeof environment === 'object' && !Array.isArray(environment) && environment.sessionPurpose === 'self_awake')
      throw new DesktopError('自醒任务不继承聊天中的桌面控制授权', 'DESKTOP_BACKGROUND_DENIED')
  }
  async release(sessionId: string) {
    for (const key of this.grants.keys()) if (key.startsWith(`${sessionId}:`)) this.grants.delete(key)
    if (await this.client.connect(false)) await this.client.request({ type: 'release', session: sessionId }, AbortSignal.timeout(5000))
  }
  close() { this.grants.clear(); this.client.close() }
}

function executionScope(turn: string, actor: string | number | undefined) {
  return createHash('sha256').update(`${turn}:${actor ?? 'root'}`).digest('hex').slice(0, 32)
}

function confirmedAction(result: JsonValue) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.kind !== 'action') return false
  const verification = result.verification, execution = result.execution
  return verification && typeof verification === 'object' && !Array.isArray(verification) && verification.state === 'confirmed'
    && execution && typeof execution === 'object' && !Array.isArray(execution) && execution.state === 'dispatched'
}
