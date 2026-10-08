import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../accounts/index.ts'
import type { SessionService } from '../sessions/index.ts'
import { assistantParticipant, loadMonCatalog, parseCoreAssistant } from '../mon/index.ts'
import type { MonBindingService } from '../mon/index.ts'

interface PrivateIdentity {
  user_id: string; bot_qq: string; contact_qq: string; assistant_id: number; character_id: number
}

/** Bind private conversations without replacing an active or held input's character. */
export class QqPrivateSessionBindings {
  constructor(private readonly identity: MonServiceIdentity, private readonly database: EdenDatabase,
    private readonly sessions: SessionService, private readonly mon: MonBindingService,
    private readonly signal: AbortSignal) {}

  private account(userId: string) {
    return { key: accountKey(this.identity.coreBaseUrl, userId), userId, coreBaseUrl: this.identity.coreBaseUrl }
  }

  async resolve(input: PrivateIdentity): Promise<string> {
    const row = this.database.connection.prepare('SELECT session_id FROM qq_channel_conversations WHERE bot_qq=? AND contact_qq=?')
      .get(input.bot_qq, input.contact_qq)
    const oldSessionId = row ? String(row.session_id) : undefined
    const account = this.account(input.user_id)
    const oldSession = oldSessionId ? withAccount(account, () => this.sessions.repository.read(oldSessionId)) : undefined
    const author = oldSession?.participants[0]
    const correctAuthor = oldSession?.status === 'active' && author && typeof author === 'object' &&
      !Array.isArray(author) && String(author.assistantId) === String(input.assistant_id) &&
      String(author.characterId) === String(input.character_id)
    if (correctAuthor) return oldSessionId!
    const sessionId = await this.create(input, oldSessionId)
    if (oldSessionId && oldSession?.status === 'active')
      await withAccount(account, () => this.sessions.endSession(oldSessionId, 'closed'))
    return sessionId
  }

  private async create(input: PrivateIdentity, previousId?: string): Promise<string> {
    if (previousId && this.database.connection.prepare(
      "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('queued','running','held') LIMIT 1").get(previousId))
      throw new Error('Wait for the current QQ turn before changing its bound character')
    const token = await acquireMonServiceToken(this.identity, this.signal)
    const client = new MonClient(this.identity.coreBaseUrl, token)
    const detail = parseCoreAssistant(await client.get(`/api/assistants/${input.assistant_id}/`, this.signal), input.assistant_id)
    if (String(detail.character.id) !== String(input.character_id)) throw new Error('QQ bound character does not match assistant')
    const catalog = await loadMonCatalog(client, input.assistant_id, this.signal)
    if (!catalog.binding || String(catalog.catalog.character.id) !== String(input.character_id))
      throw new Error('QQ bound character has no available model')
    const account = this.account(input.user_id)
    const session = withAccount(account, () => this.sessions.repository.create('QQ 私聊', [assistantParticipant(detail)],
      { sessionPurpose: 'user_chat', sourceChannel: 'qq', botQq: input.bot_qq, contactQq: input.contact_qq,
        locale: 'zh-CN', timezone: 'Asia/Shanghai' }, { purpose: 'user_chat', sourceChannel: 'qq' }))
    try {
      await this.mon.catalog({ sessionId: session.id, coreBaseUrl: this.identity.coreBaseUrl, coreToken: token, serviceCredential: true })
      this.signal.throwIfAborted()
      this.bind(input, session.id, previousId)
      return session.id
    } catch (error) {
      await withAccount(account, () => this.sessions.endSession(session.id, 'closed'))
      throw error
    }
  }

  private bind(input: PrivateIdentity, sessionId: string, previousId?: string): void {
    if (previousId) {
      const changed = this.database.connection.prepare(
        'UPDATE qq_channel_conversations SET session_id=?,created_at=? WHERE bot_qq=? AND contact_qq=? AND session_id=?')
        .run(sessionId, Date.now(), input.bot_qq, input.contact_qq, previousId)
      if (changed.changes !== 1) throw new Error('QQ conversation changed while rebinding')
    } else {
      this.database.connection.prepare('INSERT INTO qq_channel_conversations(bot_qq,contact_qq,session_id,created_at) VALUES(?,?,?,?)')
        .run(input.bot_qq, input.contact_qq, sessionId, Date.now())
    }
  }
}
