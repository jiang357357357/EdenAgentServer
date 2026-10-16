import { z } from 'zod'
import { attachmentRefsSchema, QQ_FILE_MAX_ATTACHMENTS } from '@eden/api'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../accounts/index.ts'
import type { SessionService } from '../sessions/index.ts'
import { assistantParticipant, loadMonCatalog } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'

const qq = z.string().regex(/^\d{5,20}$/)
const identityFields = { user_id: z.string(), bot_qq: qq, group_qq: qq, contact_qq: qq }
const submitSchema = z.object({ ...identityFields, schema_version: z.enum(['qq-group-turn.v1', 'qq-group-turn.v2']),
  message_id: z.string().min(1).max(128), text: z.string().trim().min(1).max(4000),
  assistant_id: z.number().int().positive(), character_id: z.number().int().positive(),
  allow_actions: z.boolean().default(false), attachments: attachmentRefsSchema.max(QQ_FILE_MAX_ATTACHMENTS).default([]),
  quoted_message_id: z.string().min(1).max(128).optional() }).strict().refine(input =>
    input.attachments.length ? input.schema_version === 'qq-group-turn.v2' && Boolean(input.quoted_message_id)
      : input.quoted_message_id === undefined, 'Group attachments require the v2 protocol and a quoted file message')
const statusSchema = z.object({ ...identityFields, input_id: z.uuid(),
  after_seq: z.string().regex(/^\d+$/).default('0') }).strict()
type GroupInput = z.infer<typeof submitSchema>

export function isGroupChannelInput(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && Object.hasOwn(raw, 'group_qq'))
}

/** Group context never shares the private QQ conversation or its pending attachments. */
export class QqGroupBridge {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly identity: MonServiceIdentity, private readonly database: EdenDatabase,
    private readonly sessions: SessionService, private readonly mon: MonBindingService,
    private readonly signal: AbortSignal) {}

  submit(raw: unknown): Promise<unknown> {
    const input = submitSchema.parse(raw)
    this.assertOwner(input.user_id)
    const task = this.tail.then(() => this.submitTurn(input))
    this.tail = task.catch(() => {})
    return task
  }

  private assertOwner(userId: string) {
    if (userId !== this.identity.userId) throw new Error('QQ group owner mismatch')
    this.signal.throwIfAborted()
  }

  private account(userId: string) {
    return { key: accountKey(this.identity.coreBaseUrl, userId), userId, coreBaseUrl: this.identity.coreBaseUrl }
  }

  private async submitTurn(input: GroupInput) {
    this.signal.throwIfAborted()
    const account = this.account(input.user_id)
    const row = this.database.connection.prepare(`SELECT g.session_id FROM qq_group_sessions g JOIN sessions s ON s.id=g.session_id
      WHERE g.bot_qq=? AND g.group_qq=? AND g.operator_qq=? AND s.status='active' ORDER BY g.created_at DESC LIMIT 1`)
      .get(input.bot_qq, input.group_qq, input.contact_qq)
    const previousId = row ? String(row.session_id) : undefined
    const previous = previousId ? withAccount(account, () => this.sessions.repository.read(previousId)) : undefined
    const author = previous?.participants[0]
    const sameAuthor = author && typeof author === 'object' && !Array.isArray(author)
      && String(author.assistantId) === String(input.assistant_id) && String(author.characterId) === String(input.character_id)
    if (previousId && !sameAuthor && this.sessions.isRunning(previousId))
      throw new Error('Wait for the group turn before changing its character')
    const sessionId = sameAuthor ? previousId! : await this.createSession(input)
    if (previousId && previousId !== sessionId) await withAccount(account, () => this.sessions.endSession(previousId, 'closed'))
    this.database.connection.prepare('UPDATE qq_group_sessions SET allow_actions=? WHERE session_id=?')
      .run(Number(input.allow_actions), sessionId)
    const key = `qq-group:${input.bot_qq}:${input.group_qq}:${input.contact_qq}:${input.message_id}`
    this.assertReplay(sessionId, key, input)
    const accepted = await withAccount(account, () => input.attachments.length
      ? this.sessions.startWithAttachments(sessionId, input.text, input.attachments, key)
      : this.sessions.start(sessionId, input.text, key))
    return { accepted: true, session_id: sessionId, input_id: accepted.inputId, turn_id: accepted.turnId, status: accepted.state }
  }

  private assertReplay(sessionId: string, key: string, input: GroupInput): void {
    const old = this.database.connection.prepare('SELECT text,metadata_json FROM inputs WHERE session_id=? AND idempotency_key=?')
      .get(sessionId, key)
    if (!old) return
    const metadata = JSON.parse(String(old.metadata_json)) as { attachments?: { blobId: string; mime: string; filename?: string }[] }
    const refs = (metadata.attachments ?? []).map(item => ({ blobId: item.blobId, mime: item.mime,
      ...(item.filename ? { filename: item.filename } : {}) }))
    if (old.text !== input.text || JSON.stringify(refs) !== JSON.stringify(input.attachments))
      throw new Error('QQ group message ID was used with different content or attachments')
  }

  private async createSession(input: GroupInput): Promise<string> {
    const token = await acquireMonServiceToken(this.identity, this.signal)
    const client = new MonClient(this.identity.coreBaseUrl, token)
    const catalog = await loadMonCatalog(client, input.assistant_id, this.signal)
    if (!catalog.binding || String(catalog.catalog.character.id) !== String(input.character_id))
      throw new Error('QQ group character has no available model')
    const author = assistantParticipant(await client.get(`/api/assistants/${input.assistant_id}/`, this.signal))
    if (!author || typeof author !== 'object' || Array.isArray(author) || String(author.characterId) !== String(input.character_id))
      throw new Error('QQ group character changed during binding')
    const account = this.account(input.user_id)
    const session = withAccount(account, () => this.sessions.repository.create('QQ 群聊', [author],
      { sessionPurpose: 'user_chat', sourceChannel: 'qq', botQq: input.bot_qq, groupQq: input.group_qq,
        contactQq: input.contact_qq, channelAudience: 'qq_group', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      { purpose: 'user_chat', sourceChannel: 'qq' }))
    this.database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)')
      .run(session.id, input.bot_qq, input.group_qq, input.contact_qq, Number(input.allow_actions), Date.now())
    try {
      await this.mon.catalog({ sessionId: session.id, coreBaseUrl: this.identity.coreBaseUrl, coreToken: token, serviceCredential: true })
      this.signal.throwIfAborted()
      return session.id
    } catch (error) {
      await withAccount(account, () => this.sessions.endSession(session.id, 'closed'))
      throw error
    }
  }

  status(raw: unknown): unknown {
    const input = statusSchema.parse(raw)
    this.assertOwner(input.user_id)
    const row = this.database.connection.prepare(`SELECT i.session_id,i.turn_id,i.state FROM inputs i
      JOIN qq_group_sessions g ON g.session_id=i.session_id
      WHERE i.id=? AND g.bot_qq=? AND g.group_qq=? AND g.operator_qq=?`)
      .get(input.input_id, input.bot_qq, input.group_qq, input.contact_qq)
    if (!row) throw new Error('QQ group turn not found')
    withAccount(this.account(input.user_id), () => this.sessions.repository.ownership.assert(String(row.session_id)))
    // No tool output, approval details, file exports or internal errors are published to the group.
    const result = { status: String(row.state), updates: [], next_seq: input.after_seq, has_more: false }
    if (row.state !== 'completed') return result
    const messages = this.database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=? AND turn_id=?
      AND kind='agent.message_end' ORDER BY seq DESC`).all(row.session_id!, row.turn_id!)
    for (const item of messages) {
      const payload = JSON.parse(String(item.payload_json)) as { message?: { role?: string; content?: unknown } }
      if (payload.message?.role !== 'assistant') continue
      const content = payload.message.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
      if (!text.trim()) continue
      return { ...result, text }
    }
    return { ...result, text: '' }
  }

  async close(): Promise<void> { await this.tail.catch(() => {}) }
}
