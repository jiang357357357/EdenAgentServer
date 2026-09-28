import { accountKey, withAccount } from '../accounts/index.ts'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import type { SessionService } from '../sessions/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { BlobService } from '../blobs/index.ts'
import type { AttachmentService } from '../attachments/service.ts'
import { attachmentRefsSchema } from '@eden/api'
import { assistantParticipant, loadMonCatalog } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { parseCoreAssistant } from '../mon/model-schema.ts'
import { z } from 'zod'

const qq = z.string().regex(/^\d{5,20}$/)
const identity = { assistant_id: z.number().int().positive(), character_id: z.number().int().positive() }
const submitInput = z.object({ schema_version: z.enum(['qq-turn.v2', 'qq-turn.v3']), user_id: z.string(), bot_qq: qq,
  contact_qq: qq, message_id: z.string().min(1).max(128), text: z.string().trim().min(1).max(4000),
  attachments: attachmentRefsSchema.default([]), ...identity }).strict()
const fileInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  input_id: z.uuid(), blob_id: z.uuid() }).strict()
const uploadInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  filename: z.string().min(1).max(255), mime: z.string().min(1).max(255),
  content_base64: z.string().max(11_184_812) }).strict()
const stageInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  message_id: z.string().min(1).max(128), attachments: attachmentRefsSchema.min(1).max(4) }).strict()
const pendingLifetime = 30 * 60 * 1000
const statusInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq, input_id: z.uuid(),
  after_seq: z.string().regex(/^\d+$/).default('0') }).strict()
const availabilityInput = z.object({ user_id: z.string().min(1), bot_qq: qq, contact_qq: qq, ...identity }).strict()
const approvalInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  request_id: z.uuid().optional(), decision: z.enum(['allow', 'deny']) }).strict()
const permissionModeInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq,
  mode: z.enum(['restricted', 'full_access', 'takeover']).optional() }).strict()

function brief(value: unknown, limit = 180): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\b(password|token|secret|api[_-]?key)=\S+/gi, '$1=[隐藏]').slice(0, limit)
}

function permissionPreview(details: unknown): string {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return ''
  const value = details as Record<string, unknown>
  if (value.action === 'create_reminder' && value.input && typeof value.input === 'object' && !Array.isArray(value.input)) {
    const reminder = value.input as Record<string, unknown>
    const remindAt = typeof reminder.remindAt === 'number' && Number.isFinite(reminder.remindAt)
      && Math.abs(reminder.remindAt) <= 8.64e15
      ? new Date(reminder.remindAt).toISOString() : reminder.remindAt
    return `提醒: ${brief(reminder.title, 100)}；时间: ${brief(remindAt, 60)}`
  }
  for (const key of ['command', 'path', 'url', 'queries', 'query', 'action']) {
    const item = value[key]
    if (item !== undefined) return `${key}: ${brief(Array.isArray(item) ? item.join(', ') : item)}`
  }
  return ''
}

function resultSummary(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ''
  const value = result as Record<string, unknown>
  if (typeof value.exitCode === 'number') return `退出码 ${value.exitCode}`
  if (typeof value.path === 'string' && typeof value.bytes === 'number') return `${brief(value.path, 100)}，${value.bytes} 字节`
  for (const key of ['results', 'entries', 'items']) {
    if (Array.isArray(value[key])) return `${value[key].length} 项`
  }
  return ''
}

export class QqChannelBridge {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()
  constructor(readonly identity: MonServiceIdentity, readonly database: EdenDatabase,
    private readonly sessions: SessionService, private readonly mon: MonBindingService,
    private readonly permissions: PermissionService, private readonly blobs: BlobService,
    private readonly attachments: AttachmentService) {}

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
      if (refs.length > 4) throw new Error('最多暂存 4 个文件，请先发送文字消息')
      await withAccount(account, () => this.attachments.snapshot(refs))
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
    if (bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== input.content_base64)
      throw new Error('QQ file exceeds 8 MiB or is not canonical base64')
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
      if (bytes.length > 8 * 1024 * 1024) throw new Error('QQ file exceeds 8 MiB')
      return { filename: JSON.parse(String(event.payload_json)).filename, mime: info.mime,
        sha256: info.sha256, byteLength: info.byteLength, content_base64: bytes.toString('base64') }
    })
  }

  async close(): Promise<void> { this.abort.abort(); await this.tail.catch(() => {}) }

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
    const input = submitInput.parse(raw)
    if (input.user_id !== this.identity.userId) throw new Error('QQ channel owner mismatch')
    const task = this.tail.then(async () => {
      this.abort.signal.throwIfAborted()
      const account = { key: accountKey(this.identity.coreBaseUrl, input.user_id),
        userId: input.user_id, coreBaseUrl: this.identity.coreBaseUrl }
      let row = this.database.connection.prepare('SELECT session_id FROM qq_channel_conversations WHERE bot_qq=? AND contact_qq=?')
        .get(input.bot_qq, input.contact_qq)
      const oldSessionId = row ? String(row.session_id) : undefined
      const oldSession = oldSessionId ? withAccount(account, () => this.sessions.repository.read(oldSessionId)) : undefined
      const existingAuthor = oldSession?.participants[0]
      const correctAuthor = oldSession?.status === 'active' && existingAuthor && typeof existingAuthor === 'object' &&
        !Array.isArray(existingAuthor) && String(existingAuthor.assistantId) === String(input.assistant_id) &&
        String(existingAuthor.characterId) === String(input.character_id)
      if (!correctAuthor) {
        if (oldSessionId && this.database.connection.prepare(
          "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('queued','running','held') LIMIT 1").get(oldSessionId))
          throw new Error('Wait for the current QQ turn before changing its bound character')
        const token = await acquireMonServiceToken(this.identity, this.abort.signal)
        const client = new MonClient(this.identity.coreBaseUrl, token)
        const detail = parseCoreAssistant(await client.get(`/api/assistants/${input.assistant_id}/`, this.abort.signal), input.assistant_id)
        if (String(detail.character.id) !== String(input.character_id)) throw new Error('QQ bound character does not match assistant')
        const catalog = await loadMonCatalog(client, input.assistant_id, this.abort.signal)
        if (!catalog.binding || String(catalog.catalog.character.id) !== String(input.character_id))
          throw new Error('QQ bound character has no available model')
        const author = assistantParticipant(detail)
        const session = withAccount(account, () => this.sessions.repository.create('QQ 私聊', [author],
          { sessionPurpose: 'user_chat', sourceChannel: 'qq', botQq: input.bot_qq, contactQq: input.contact_qq,
            locale: 'zh-CN', timezone: 'Asia/Shanghai' }, { purpose: 'user_chat', sourceChannel: 'qq' }))
        try {
          await this.mon.catalog({ sessionId: session.id, coreBaseUrl: this.identity.coreBaseUrl, coreToken: token })
          this.abort.signal.throwIfAborted()
          if (oldSessionId) {
            const changed = this.database.connection.prepare(
              'UPDATE qq_channel_conversations SET session_id=?,created_at=? WHERE bot_qq=? AND contact_qq=? AND session_id=?')
              .run(session.id, Date.now(), input.bot_qq, input.contact_qq, oldSessionId)
            if (changed.changes !== 1) throw new Error('QQ conversation changed while rebinding')
          } else {
            this.database.connection.prepare('INSERT INTO qq_channel_conversations(bot_qq,contact_qq,session_id,created_at) VALUES(?,?,?,?)')
              .run(input.bot_qq, input.contact_qq, session.id, Date.now())
          }
          row = { session_id: session.id }
        } catch (error) {
          await withAccount(account, () => this.sessions.endSession(session.id, 'closed'))
          throw error
        }
        if (oldSessionId && oldSession?.status === 'active')
          await withAccount(account, () => this.sessions.endSession(oldSessionId, 'closed'))
      }
      if (!row) throw new Error('QQ conversation was not created')
      const sessionId = String(row.session_id)
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
      if (refs.length > 4) throw new Error('本轮文件超过 4 个，请先只发文字处理已暂存文件')
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
    const eventRows = this.database.connection.prepare(`SELECT CAST(seq AS TEXT) AS seq,kind,payload_json FROM events
      WHERE session_id=? AND turn_id=? AND seq>? AND kind IN
        ('operation.started','operation.completed','permission.requested','permission.resolved','qq.file_requested') ORDER BY seq LIMIT 100`)
      .all(sessionId, turnId, BigInt(input.after_seq))
    const updates: Record<string, unknown>[] = []
    for (const event of eventRows) {
      const payload = JSON.parse(String(event.payload_json)) as Record<string, unknown>
      const seq = String(event.seq)
      if (event.kind === 'operation.started') {
        updates.push({ seq, kind: 'tool_start', name: brief(payload.name, 80) })
      } else if (event.kind === 'operation.completed') {
        const operation = this.database.connection.prepare('SELECT tool_name FROM tool_operations WHERE id=? AND session_id=?')
          .get(`${turnId}:${String(payload.callId ?? '')}`, sessionId)
        updates.push({ seq, kind: 'tool_end', name: brief(operation?.tool_name, 80),
          outcome: payload.outcome === 'completed' ? 'completed' : 'failed', summary: resultSummary(payload.result) })
      } else if (event.kind === 'permission.requested') {
        const permission = this.database.connection.prepare('SELECT state FROM permission_requests WHERE id=? AND session_id=?')
          .get(String(payload.id ?? ''), sessionId)
        if (permission?.state !== 'pending') continue
        updates.push({ seq, kind: 'approval', request_id: String(payload.id ?? ''),
          capability: brief(payload.capability, 80), resource: brief(payload.resource, 180),
          preview: permissionPreview(payload.details) })
      } else if (event.kind === 'permission.resolved') {
        updates.push({ seq, kind: 'approval_resolved', request_id: String(payload.requestId ?? ''),
          state: brief(payload.state, 30) })
      } else if (event.kind === 'qq.file_requested') {
        updates.push({ seq, kind: 'file_send', blob_id: String(payload.blobId ?? ''),
          filename: String(payload.filename ?? ''), byte_length: Number(payload.byteLength ?? 0) })
      }
    }
    const next_seq = eventRows.length ? String(eventRows[eventRows.length - 1]!.seq) : input.after_seq
    const has_more = eventRows.length === 100
    const state = String(row.state)
    if (state !== 'completed') return { status: state, error: row.error == null ? null : String(row.error), updates, next_seq, has_more }
    const messages = this.database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=? AND turn_id=?
      AND kind='agent.message_end' ORDER BY seq DESC`).all(row.session_id!, row.turn_id!)
    for (const item of messages) {
      const payload = JSON.parse(String(item.payload_json)) as { message?: { role?: string; content?: string | { type?: string; text?: string }[] } }
      if (payload.message?.role !== 'assistant') continue
      const content = payload.message.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
      return { status: 'completed', text, updates, next_seq, has_more }
    }
    return { status: 'completed', text: '', updates, next_seq, has_more }
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
