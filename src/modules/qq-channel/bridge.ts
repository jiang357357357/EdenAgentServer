import { accountKey, withAccount } from '../accounts/index.ts'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import type { SessionService } from '../sessions/index.ts'
import { assistantParticipant } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { z } from 'zod'

const qq = z.string().regex(/^\d{5,20}$/)
const submitInput = z.object({ schema_version: z.literal('qq-turn.v1'), user_id: z.string(), bot_qq: qq,
  contact_qq: qq, message_id: z.string().min(1).max(128), text: z.string().trim().min(1).max(4000) }).strict()
const statusInput = z.object({ user_id: z.string(), bot_qq: qq, contact_qq: qq, input_id: z.uuid() }).strict()

export class QqChannelBridge {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()
  constructor(readonly identity: MonServiceIdentity, readonly database: EdenDatabase,
    private readonly sessions: SessionService, private readonly mon: MonBindingService) {}

  async close(): Promise<void> { this.abort.abort(); await this.tail.catch(() => {}) }

  consumeNonce(nonce: string): void {
    this.database.transaction(() => {
      this.database.connection.prepare('DELETE FROM service_nonces WHERE expires_at<?').run(Date.now())
      if (Number(this.database.connection.prepare('SELECT COUNT(*) AS count FROM service_nonces').get()?.count) >= 10000)
        throw new Error('Service nonce capacity reached')
      this.database.connection.prepare('INSERT INTO service_nonces(nonce,expires_at) VALUES(?,?)').run(`qq:${nonce}`, Date.now() + 600000)
    })
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
      if (!row) {
        const token = await acquireMonServiceToken(this.identity, this.abort.signal)
        const client = new MonClient(this.identity.coreBaseUrl, token)
        const author = assistantParticipant(await client.get('/api/assistants/current/', this.abort.signal))
        const session = withAccount(account, () => this.sessions.repository.create('QQ 私聊', [author],
          { sessionPurpose: 'user_chat', sourceChannel: 'qq', botQq: input.bot_qq, contactQq: input.contact_qq,
            locale: 'zh-CN', timezone: 'Asia/Shanghai' }, { purpose: 'user_chat', sourceChannel: 'qq' }))
        try {
          await this.mon.catalog({ sessionId: session.id, coreBaseUrl: this.identity.coreBaseUrl, coreToken: token })
          this.abort.signal.throwIfAborted()
          this.database.connection.prepare('INSERT INTO qq_channel_conversations(bot_qq,contact_qq,session_id,created_at) VALUES(?,?,?,?)')
            .run(input.bot_qq, input.contact_qq, session.id, Date.now())
          row = { session_id: session.id }
        } catch (error) {
          await withAccount(account, () => this.sessions.endSession(session.id, 'closed'))
          throw error
        }
      }
      const sessionId = String(row.session_id)
      const key = `qq:${input.bot_qq}:${input.contact_qq}:${input.message_id}`
      const previous = this.database.connection.prepare('SELECT id,turn_id,state,text FROM inputs WHERE session_id=? AND idempotency_key=?')
        .get(sessionId, key)
      if (previous) {
        if (previous.text !== input.text) throw new Error('QQ message ID was used with different content')
        return { accepted: true, session_id: sessionId, input_id: String(previous.id),
          turn_id: String(previous.turn_id), status: String(previous.state) }
      }
      const accepted = withAccount(account, () => this.sessions.start(sessionId, input.text, key))
      return { accepted: true, session_id: sessionId, input_id: accepted.inputId, turn_id: accepted.turnId, status: accepted.state }
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
    const state = String(row.state)
    if (state !== 'completed') return { status: state, error: row.error == null ? null : String(row.error) }
    const messages = this.database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=? AND turn_id=?
      AND kind='agent.message_end' ORDER BY seq DESC`).all(row.session_id!, row.turn_id!)
    for (const item of messages) {
      const payload = JSON.parse(String(item.payload_json)) as { message?: { role?: string; content?: string | { type?: string; text?: string }[] } }
      if (payload.message?.role !== 'assistant') continue
      const content = payload.message.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
      return { status: 'completed', text }
    }
    return { status: 'completed', text: '' }
  }
}
