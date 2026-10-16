import { accountKey, withAccount } from '../accounts/index.ts'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import type { SessionService } from '../sessions/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { BlobService } from '../blobs/index.ts'
import type { AttachmentService } from '../attachments/index.ts'
import { attachmentRefsSchema, QQ_FILE_MAX_BYTES, QQ_FILE_MAX_BASE64_LENGTH,
  QQ_FILE_MAX_ATTACHMENTS, QQ_FILE_MAX_INPUT_BYTES } from '@eden/api'
import { loadMonCatalog } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { z } from 'zod'
import { privateTurnStatus } from './reply-status.ts'
import { QqPrivateSessionBindings } from './private-session.ts'
import { isGroupChannelInput, QqGroupBridge } from './group-bridge.ts'

const qq = z.string().regex(/^\d{5,20}$/)
const identity = { assistant_id: z.number().int().positive(), character_id: z.number().int().positive() }
const submitInput = z.object({ schema_version: z.enum(['qq-turn.v2', 'qq-turn.v3']), user_id: z.string(), bot_qq: qq,
  contact_qq: qq, message_id: z.string().min(1).max(128), text: z.string().trim().min(1).max(4000),
  attachments: attachmentRefsSchema.default([]), ...identity }).strict()
const fileInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  input_id: z.uuid(), blob_id: z.uuid() }).strict()
const uploadInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  group_qq: qq.optional(),
  filename: z.string().min(1).max(255), mime: z.string().min(1).max(255),
  content_base64: z.string().max(QQ_FILE_MAX_BASE64_LENGTH) }).strict()
const stageInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  message_id: z.string().min(1).max(128), attachments: attachmentRefsSchema.min(1).max(QQ_FILE_MAX_ATTACHMENTS) }).strict()
const pendingLifetime = 30 * 60 * 1000
const statusInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq, input_id: z.uuid(),
  after_seq: z.string().regex(/^\d+$/).default('0') }).strict()
const availabilityInput = z.object({ user_id: z.string().min(1), bot_qq: qq, contact_qq: qq, ...identity }).strict()
const approvalInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  request_id: z.uuid().optional(), decision: z.enum(['allow', 'deny']) }).strict()
const permissionModeInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  mode: z.enum(['restricted', 'full_access', 'takeover']).optional() }).strict()

export class QqChannelBridge {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()
  private readonly group: QqGroupBridge
  private readonly privateSessions: QqPrivateSessionBindings
  constructor(readonly identity: MonServiceIdentity, readonly database: EdenDatabase,
    private readonly sessions: SessionService, private readonly mon: MonBindingService,
    private readonly permissions: PermissionService, private readonly blobs: BlobService,
    private readonly attachments: AttachmentService) {
    this.group = new QqGroupBridge(identity, database, sessions, mon, this.abort.signal)
    this.privateSessions = new QqPrivateSessionBindings(identity, database, sessions, mon, this.abort.signal)
  }

  stage(raw: unknown): Promise<unknown> {
    const input = stageInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const task = this.tail.then(async () => {
      this.abort.signal.throwIfAborted()
      const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
        userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
      this.database.connection.prepare('DELETE FROM qq_channel_pending_files WHERE created_at<?')
        .run(Date.now() - pendingLifetime)
      const rows = this.database.connection.prepare(`SELECT message_id,attachments_json FROM qq_channel_pending_files
        WHERE owner_id=? AND bot_qq=? AND contact_qq=? ORDER BY created_at,rowid`)
        .all(input.user_id, input.bot_qq, input.contact_qq)
      const previous = rows.find(row => row.message_id === input.message_id)
      if (previous) {
        if (previous.attachments_json !== JSON.stringify(input.attachments))
          throw new Error('QQ message ID was used with different files')
        const count = rows.reduce((sum, row) => sum + attachmentRefsSchema.parse(JSON.parse(String(row.attachments_json))).length, 0)
        return { staged: true, count, expires_in_seconds: pendingLifetime / 1000 }
      }
      const refs = rows.flatMap(row => attachmentRefsSchema.parse(JSON.parse(String(row.attachments_json))))
        .concat(input.attachments)
      if (refs.length > QQ_FILE_MAX_ATTACHMENTS) throw new Error('最多暂存 4 个文件，请先发送文字消息')
      await withAccount(account, () => this.attachments.snapshot(refs, QQ_FILE_MAX_INPUT_BYTES))
      this.database.connection.prepare(`INSERT INTO qq_channel_pending_files
        (owner_id,bot_qq,contact_qq,message_id,attachments_json,created_at) VALUES(?,?,?,?,?,?)`)
        .run(input.user_id, input.bot_qq, input.contact_qq, input.message_id,
          JSON.stringify(input.attachments), Date.now())
      return { staged: true, count: refs.length, expires_in_seconds: pendingLifetime / 1000 }
    })
    this.tail = task.catch(() => {})
    return task
  }

  async upload(raw: unknown): Promise<unknown> {
    const input = uploadInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    if ((input.content_base64 && !/^[A-Za-z0-9+/]+={0,2}$/.test(input.content_base64)) || input.content_base64.length % 4)
      throw new Error('Invalid QQ file encoding')
    const bytes = Buffer.from(input.content_base64, 'base64')
    if (bytes.length > QQ_FILE_MAX_BYTES || bytes.toString('base64') !== input.content_base64)
      throw new Error('QQ file exceeds 100 MB or is not canonical base64')
    const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
      userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
    const info = await withAccount(account, () => this.blobs.put(bytes, input.mime))
    return { blobId: info.id, mime: info.mime, filename: input.filename,
      sha256: info.sha256, byteLength: info.byteLength }
  }

  async file(raw: unknown): Promise<unknown> {
    const input = fileInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const row = this.database.connection.prepare(`SELECT i.session_id,i.turn_id FROM inputs i
      JOIN qq_channel_conversations q ON q.session_id=i.session_id
      WHERE i.id=? AND q.bot_qq=? AND q.contact_qq=?`).get(input.input_id, input.bot_qq, input.contact_qq)
    if (!row) throw new Error('QQ channel input not found')
    const event = this.database.connection.prepare(`SELECT payload_json FROM events
      WHERE session_id=? AND turn_id=? AND kind='qq.file_requested'
      AND json_extract(payload_json,'$.blobId')=? LIMIT 1`).get(row.session_id!, row.turn_id!, input.blob_id)
    if (!event) throw new Error('QQ file was not requested by this turn')
    const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
      userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
    return withAccount(account, async () => {
      this.sessions.repository.ownership.assert(String(row.session_id))
      const { info, bytes } = await this.blobs.read(input.blob_id)
      if (bytes.length > QQ_FILE_MAX_BYTES) throw new Error('QQ file exceeds 100 MB')
      return { filename: JSON.parse(String(event.payload_json)).filename, mime: info.mime,
        sha256: info.sha256, byteLength: info.byteLength, content_base64: bytes.toString('base64') }
    })
  }

  async close(): Promise<void> { this.abort.abort(); await Promise.all([this.tail.catch(() => {}), this.group.close()]) }

  consumeNonce(nonce: string): void {
    this.database.transaction(() => {
      this.database.connection.prepare('DELETE FROM service_nonces WHERE expires_at<?').run(Date.now())
      if (Number(this.database.connection.prepare('SELECT COUNT(*) AS count FROM service_nonces').get()?.count) >= 10000)
        throw new Error('Service nonce capacity reached')
      this.database.connection.prepare('INSERT INTO service_nonces(nonce,expires_at) VALUES(?,?)').run(`qq:${nonce}`, Date.now() + 600000)
    })
  }

  async availability(raw: unknown): Promise<unknown> {
    const input = availabilityInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const token = await acquireMonServiceToken(this.identity, this.abort.signal)
    const result = await loadMonCatalog(new MonClient(this.identity.coreBaseUrl, token), input.assistant_id, this.abort.signal)
    if (String(result.catalog.character.id) !== String(input.character_id)) throw new Error('QQ bound character does not match assistant')
    return { available: Boolean(result.binding), reason: result.binding ? null : 'NO_MODEL',
      assistant_id: String(result.catalog.assistant.id) }
  }

  submit(raw: unknown): Promise<unknown> {
    if (isGroupChannelInput(raw)) return this.group.submit(raw)
    const input = submitInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const task = this.tail.then(async () => {
      this.abort.signal.throwIfAborted()
      const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
        userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
      const sessionId = await this.privateSessions.resolve(input)
      withAccount(account, () => this.sessions.repository.ownership.assert(sessionId))
      const key = `qq:${input.bot_qq}:${input.contact_qq}:${input.message_id}`
      const previous = this.database.connection.prepare('SELECT id,turn_id,state,text,metadata_json FROM inputs WHERE session_id=? AND idempotency_key=?')
        .get(sessionId, key)
      if (previous) {
        if (previous.text !== input.text) throw new Error('QQ message ID was used with different content')
        const saved = JSON.parse(String(previous.metadata_json)) as { attachments?: { blobId: string; mime: string; filename?: string }[] }
        const refs = (saved.attachments ?? []).map(item => ({ blobId: item.blobId, mime: item.mime,
          ...(item.filename ? { filename: item.filename } : {}) }))
        if (input.attachments.length && JSON.stringify(refs.slice(-input.attachments.length)) !== JSON.stringify(input.attachments))
          throw new Error('QQ message ID was used with different attachments')
        return { accepted: true, session_id: sessionId, input_id: String(previous.id),
          turn_id: String(previous.turn_id), status: String(previous.state) }
      }
      const expired = this.database.connection.prepare(`SELECT attachments_json FROM qq_channel_pending_files
        WHERE owner_id=? AND bot_qq=? AND contact_qq=? AND created_at<?`)
        .all(input.user_id, input.bot_qq, input.contact_qq, Date.now() - pendingLifetime)
      const expiredCount = expired.reduce((sum, item) => sum +
        attachmentRefsSchema.parse(JSON.parse(String(item.attachments_json))).length, 0)
      this.database.connection.prepare('DELETE FROM qq_channel_pending_files WHERE created_at<?')
        .run(Date.now() - pendingLifetime)
      const pending = this.database.connection.prepare(`SELECT attachments_json FROM qq_channel_pending_files
        WHERE owner_id=? AND bot_qq=? AND contact_qq=? ORDER BY created_at,rowid`)
        .all(input.user_id, input.bot_qq, input.contact_qq)
      const refs = pending.flatMap(item => attachmentRefsSchema.parse(JSON.parse(String(item.attachments_json))))
        .concat(input.attachments)
      if (refs.length > QQ_FILE_MAX_ATTACHMENTS) throw new Error('本轮文件超过 4 个，请先只发文字处理已暂存文件')
      const accepted = await withAccount(account, () => refs.length
        ? this.sessions.startWithAttachments(sessionId, input.text, refs, key, undefined, () => {
          this.database.connection.prepare(`DELETE FROM qq_channel_pending_files
            WHERE owner_id=? AND bot_qq=? AND contact_qq=?`).run(input.user_id, input.bot_qq, input.contact_qq)
        })
        : this.sessions.start(sessionId, input.text, key))
      return { accepted: true, session_id: sessionId, input_id: accepted.inputId, turn_id: accepted.turnId,
        status: accepted.state, expired_files: expiredCount }
    })
    this.tail = task.catch(() => {})
    return task
  }

  status(raw: unknown): unknown {
    if (isGroupChannelInput(raw)) return this.group.status(raw)
    const input = statusInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const row = this.database.connection.prepare(`SELECT i.session_id,i.turn_id,i.state,t.error FROM inputs i
      JOIN qq_channel_conversations q ON q.session_id=i.session_id
      LEFT JOIN turns t ON t.id=i.turn_id
      WHERE i.id=? AND q.bot_qq=? AND q.contact_qq=?`).get(input.input_id, input.bot_qq, input.contact_qq)
    if (!row) throw new Error('QQ channel turn not found')
    const sessionId = String(row.session_id)
    const turnId = String(row.turn_id)
    const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
      userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
    withAccount(account, () => this.sessions.repository.ownership.assert(sessionId))
    return privateTurnStatus(this.database, sessionId, turnId, row, input.after_seq)
  }

  resolvePermission(raw: unknown): unknown {
    const input = approvalInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
      userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
    const conversation = this.database.connection.prepare('SELECT session_id FROM qq_channel_conversations WHERE bot_qq=? AND contact_qq=?')
      .get(input.bot_qq, input.contact_qq)
    if (!conversation) return { resolved: false, reason: 'none' }
    withAccount(account, () => this.sessions.repository.ownership.assert(String(conversation.session_id)))
    const pending = this.database.connection.prepare(`SELECT p.id FROM permission_requests p
      JOIN qq_channel_conversations q ON q.session_id=p.session_id
      JOIN inputs i ON i.session_id=p.session_id AND i.turn_id=p.turn_id
      JOIN session_classification c ON c.session_id=p.session_id AND c.source_channel='qq'
      WHERE q.bot_qq=? AND q.contact_qq=? AND p.state='pending' AND i.state='running'
      AND (? IS NULL OR p.id=?) ORDER BY p.created_at`).all(
        input.bot_qq, input.contact_qq, input.request_id ?? null, input.request_id ?? null)
    if (pending.length === 0) return { resolved: false, reason: 'none' }
    if (pending.length > 1) return { resolved: false, reason: 'multiple' }
    const requestId = String(pending[0]!.id)
    withAccount(account, () => this.permissions.resolve(requestId, input.decision === 'allow'))
    return { resolved: true, decision: input.decision }
  }

  permissionMode(raw: unknown): unknown {
    const input = permissionModeInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const mode = input.mode === undefined
      ? this.permissions.qqMode(input.bot_qq, input.contact_qq)
      : this.permissions.setQqMode(input.bot_qq, input.contact_qq, input.mode)
    return { mode }
  }
}
