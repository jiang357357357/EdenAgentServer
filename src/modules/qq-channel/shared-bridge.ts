import { z } from 'zod'
import { attachmentRefsSchema, QQ_FILE_MAX_ATTACHMENTS, qqSharedContextSchema, qqSharedMessageSchema, toJson } from '@eden/api'
import type { MonServiceIdentity } from '@eden/integrations'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../accounts/index.ts'
import type { SessionService } from '../sessions/index.ts'
import { assistantParticipant, loadMonCatalog } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { QqSharedRepository } from './shared-repository.ts'
import { qqSharedInput } from './turn-origin.ts'
import { qqTurnStatus } from './reply-status.ts'
import { sharedGroupRoleChanged } from '../../model-prompts/qq-shared-history.ts'

const qq = z.string().regex(/^\d{5,20}$/)
const scope = { user_id: z.string(), bot_qq: qq, group_qq: qq, contact_qq: qq }
const author = { assistant_id: z.number().int().positive(), character_id: z.number().int().positive() }
const submit = z.object({ ...scope, ...author, schema_version: z.literal('qq-group-turn.v5'),
  message_id: z.string().min(1).max(128), text: z.string().trim().min(1).max(4000),
  context: qqSharedContextSchema, attachments: attachmentRefsSchema.max(QQ_FILE_MAX_ATTACHMENTS).default([]),
  quoted_message_id: z.string().min(1).max(128).optional(), allow_actions: z.boolean().optional(),
}).strict().refine(value => value.context.bot_qq === value.bot_qq && value.context.group_qq === value.group_qq
  && value.context.operator_qq === value.contact_qq, 'QQ input identity does not match its shared group')
  .refine(value => value.attachments.length ? Boolean(value.quoted_message_id) : value.quoted_message_id === undefined,
    'Group attachments require a quoted file message')
const history = z.object({ ...scope, ...author, messages: z.array(qqSharedMessageSchema).max(200).default([]) }).strict()
const status = z.object({ ...scope, input_id: z.uuid(), after_seq: z.string().regex(/^\d+$/).default('0') }).strict()
const cancellation = z.union([status, z.object({ ...scope, message_id: z.string().min(1).max(128) }).strict()])
type SharedInput = z.infer<typeof submit>

export class QqSharedBridge {
  private readonly repository: QqSharedRepository
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly identity: MonServiceIdentity, private readonly database: EdenDatabase,
    private readonly sessions: SessionService, private readonly mon: MonBindingService, private readonly signal: AbortSignal) {
    this.repository = new QqSharedRepository(database)
  }
  private account(userId: string) {
    if (userId !== this.identity.userId) throw new Error('QQ group owner mismatch')
    this.signal.throwIfAborted()
    return { key: accountKey(this.identity.coreBaseUrl, userId), userId, coreBaseUrl: this.identity.coreBaseUrl }
  }
  private ordered<T>(bot: string, group: string, work: () => Promise<T>): Promise<T> {
    const key = `${bot}:${group}`, previous = this.tails.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(work)
    this.tails.set(key, task)
    void task.finally(() => { if (this.tails.get(key) === task) this.tails.delete(key) }).catch(() => {})
    return task
  }
  async close(): Promise<void> { await Promise.allSettled(this.tails.values()) }

  submit(raw: unknown): Promise<unknown> {
    const input = submit.parse(raw), account = this.account(input.user_id)
    return this.ordered(input.bot_qq, input.group_qq, async () => {
      const sessionId = await this.room(input)
      const key = `qq-shared:${input.bot_qq}:${input.group_qq}:${input.message_id}`
      const old = this.database.connection.prepare(`SELECT i.*,q.operator_qq,q.source_key FROM inputs i
        JOIN qq_group_inputs q ON q.input_id=i.id WHERE i.session_id=? AND i.idempotency_key=?`).get(sessionId, key)
      if (old) {
        const saved = JSON.parse(String(old.metadata_json)) as { channelContext: unknown; attachments?: { blobId: string; mime: string; filename?: string }[] }
        const original = qqSharedContextSchema.parse(saved.channelContext)
        const refs = (saved.attachments ?? []).map(item => ({ blobId: item.blobId, mime: item.mime,
          ...(item.filename ? { filename: item.filename } : {}) }))
        if (old.text !== input.text || old.operator_qq !== input.contact_qq || old.source_key !== input.context.source_key
          || JSON.stringify(refs) !== JSON.stringify(input.attachments)
          || JSON.stringify(original.quote) !== JSON.stringify(input.context.quote)) throw new Error('QQ message replay changed its identity or content')
        return { accepted: true, session_id: sessionId, input_id: String(old.id), turn_id: String(old.turn_id), status: String(old.state) }
      }
      if (!this.repository.previousAccepted(sessionId, input.context.previous_source_key)) throw new Error('Previous group input has not been accepted')
      this.repository.ingest(sessionId, input.context.messages)
      const commit = (accepted: import('../sessions/contracts.ts').AcceptedInput) => this.repository.admit(sessionId, accepted, input.context)
      const accepted = await withAccount(account, () => input.attachments.length
        ? this.sessions.startWithAttachments(sessionId, input.text, input.attachments, key, undefined, commit, toJson(input.context))
        : this.sessions.start(sessionId, input.text, key, undefined, 'prompt', toJson(input.context), commit))
      return { accepted: true, session_id: sessionId, input_id: accepted.inputId, turn_id: accepted.turnId, status: accepted.state }
    })
  }

  ingest(raw: unknown): Promise<unknown> {
    const input = history.parse(raw); this.account(input.user_id)
    return this.ordered(input.bot_qq, input.group_qq, async () => {
      const sessionId = await this.room(input)
      return { session_id: sessionId, history_position: this.repository.ingest(sessionId, input.messages) }
    })
  }

  status(raw: unknown): unknown {
    const input = status.parse(raw), account = this.account(input.user_id)
    const row = qqSharedInput(this.database, input.input_id, input.bot_qq, input.group_qq, input.contact_qq)
    if (!row) throw new Error('QQ group turn not found')
    const sessionId = String(row.session_id)
    withAccount(account, () => this.sessions.repository.ownership.assert(sessionId))
    return qqTurnStatus(this.database, sessionId, String(row.turn_id), row, input.after_seq)
  }

  async cancel(raw: unknown): Promise<unknown> {
    const input = cancellation.parse(raw), account = this.account(input.user_id)
    const row = 'input_id' in input
      ? qqSharedInput(this.database, input.input_id, input.bot_qq, input.group_qq, input.contact_qq)
      : this.database.connection.prepare(`SELECT q.session_id,q.input_id FROM qq_group_inputs q
        JOIN qq_shared_rooms r ON r.session_id=q.session_id JOIN inputs i ON i.id=q.input_id
        WHERE r.bot_qq=? AND r.group_qq=? AND q.operator_qq=? AND i.idempotency_key=?`).get(
        input.bot_qq, input.group_qq, input.contact_qq, `qq-shared:${input.bot_qq}:${input.group_qq}:${input.message_id}`)
    if (!row) return { cancelled: false }
    const id = 'input_id' in input ? input.input_id : String(row.input_id)
    return { cancelled: await withAccount(account, () => this.sessions.cancelInput(String(row.session_id), id)) }
  }

  private async room(input: z.infer<typeof history> | SharedInput): Promise<string> {
    const account = this.account(input.user_id), previous = this.repository.room(input.bot_qq, input.group_qq)
    if (previous) {
      const session = withAccount(account, () => this.sessions.repository.read(previous))
      if (session.status !== 'active') throw new Error('Shared group session is closed')
      const participant = session.participants[0] as { assistantId?: unknown; characterId?: unknown }
      if (String(participant?.assistantId) === String(input.assistant_id) && String(participant?.characterId) === String(input.character_id)) return previous
      if (this.sessions.isRunning(previous) || this.database.connection.prepare("SELECT 1 FROM inputs WHERE session_id=? AND state IN ('queued','running')").get(previous))
        throw new Error('Finish queued group inputs before changing its character')
      const loaded = await this.author(input)
      await withAccount(account, () => this.sessions.setParticipants(previous, [loaded.participant], () =>
        this.mon.catalog({ sessionId: previous, coreBaseUrl: this.identity.coreBaseUrl, coreToken: loaded.token, serviceCredential: true })))
      this.sessions.repository.events.append(previous, null, 'qq.role.changed', { text: sharedGroupRoleChanged })
      return previous
    }
    const busy = this.database.connection.prepare(`SELECT 1 FROM qq_group_sessions g JOIN inputs i ON i.session_id=g.session_id
      WHERE g.bot_qq=? AND g.group_qq=? AND i.state IN ('queued','running') LIMIT 1`).get(input.bot_qq, input.group_qq)
    if (busy) throw new Error('Wait for existing group member tasks before switching to shared history')
    const { token, participant } = await this.author(input)
    const session = withAccount(account, () => this.sessions.repository.create('QQ 群聊', [participant],
      { sessionPurpose: 'user_chat', sourceChannel: 'qq', botQq: input.bot_qq, groupQq: input.group_qq,
        channelAudience: 'qq_group', locale: 'zh-CN', timezone: 'Asia/Shanghai' }, { purpose: 'user_chat', sourceChannel: 'qq' }))
    try {
      await withAccount(account, () => this.mon.catalog({ sessionId: session.id, coreBaseUrl: this.identity.coreBaseUrl, coreToken: token, serviceCredential: true }))
      this.repository.bind(session.id, input.bot_qq, input.group_qq)
      return session.id
    } catch (error) { await withAccount(account, () => this.sessions.endSession(session.id, 'closed')); throw error }
  }

  private async author(input: { assistant_id: number; character_id: number }) {
    const token = await acquireMonServiceToken(this.identity, this.signal)
    const client = new MonClient(this.identity.coreBaseUrl, token)
    const catalog = await loadMonCatalog(client, input.assistant_id, this.signal)
    if (!catalog.binding || String(catalog.catalog.character.id) !== String(input.character_id)) throw new Error('QQ group character has no available model')
    const participant = assistantParticipant(await client.get(`/api/assistants/${input.assistant_id}/`, this.signal))
    if (!participant || typeof participant !== 'object' || Array.isArray(participant) || String(participant.characterId) !== String(input.character_id))
      throw new Error('QQ group character changed during binding')
    return { token, participant }
  }
}
