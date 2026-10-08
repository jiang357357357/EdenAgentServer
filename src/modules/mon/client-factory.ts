import { MonClient, MonServiceCredentials, type MonServiceIdentity } from '@eden/integrations'
import { AccountAuthentication, accountKey, type Account } from '../accounts/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { MonConnection } from './connection-repository.ts'
import { migrateDestination } from './destination.ts'

export class MonClientFactory {
  private readonly abort = new AbortController()
  private readonly credentials: MonServiceCredentials | undefined
  constructor(private readonly sessions: SessionRepository, private readonly identity?: MonServiceIdentity, private readonly account?: Account,
    private readonly renewed: (id: string, base: string, previous: string, next: string) => void = () => {}) {
    if (identity && account?.key === accountKey(identity.coreBaseUrl, identity.userId)) {
      this.credentials = new MonServiceCredentials(identity, this.abort.signal)
      // One-time legacy recovery uses durable channel purpose and the configured account owner.
      sessions.database.connection.prepare(`INSERT OR IGNORE INTO mon_service_credentials
        SELECT c.session_id,c.core_base_url,1 FROM mon_connections c JOIN session_classification s ON s.session_id=c.session_id
        JOIN session_owners o ON o.session_id=c.session_id WHERE o.account_key=? AND c.core_base_url=?
        AND (s.purpose='self_awake' OR s.source_channel='qq')`).run(account.key, identity.coreBaseUrl)
    }
  }
  async validateConnection(connection: MonConnection, signal: AbortSignal, service = false) {
    if (!this.account) return
    if (new URL(connection.coreBaseUrl).href.replace(/\/+$/, '') !== new URL(this.account.coreBaseUrl).href.replace(/\/+$/, '')) {
      throw new Error('Core connection belongs to another account endpoint')
    }
    if (service) {
      if (!this.credentials || !this.matches(connection)) throw new Error('Service credential does not belong to this account runtime')
      return
    }
    const verified = await new AccountAuthentication(connection.coreBaseUrl).verify(connection.coreToken, signal)
    if (verified.key !== this.account.key) throw new Error('Core credential belongs to another account')
  }
  bindService(sessionId: string, connection: MonConnection, service: boolean) {
    const db = this.sessions.database.connection
    if (service) {
      if (!this.credentials || !this.matches(connection)) throw new Error('Service credential does not belong to this account runtime')
      const owner = db.prepare('SELECT account_key FROM session_owners WHERE session_id=?').get(sessionId)?.account_key
      if (owner !== this.account?.key) throw new Error('Service session belongs to another account')
    }
    db.prepare(`INSERT INTO mon_service_credentials VALUES(?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET core_base_url=excluded.core_base_url,enabled=excluded.enabled`).run(sessionId, connection.coreBaseUrl, Number(service))
  }
  create(sessionId: string, connection: MonConnection): MonClient {
    migrateDestination(this.sessions.database, sessionId, connection)
    const db = this.sessions.database.connection
    const service = db.prepare('SELECT core_base_url FROM mon_service_credentials WHERE session_id=? AND enabled=1').get(sessionId)
    let expectedToken = connection.coreToken
    const credentials = service && this.matches(connection) && this.credentials ? {
      token: async (signal?: AbortSignal, rejectedToken?: string) => {
        const token = await this.credentials!.token(signal, rejectedToken)
        const current = db.prepare(`SELECT c.core_token FROM mon_connections c JOIN mon_service_credentials s ON s.session_id=c.session_id
          WHERE c.session_id=? AND c.core_base_url=? AND s.enabled=1`).get(sessionId, connection.coreBaseUrl)
        if (!current || (current.core_token !== expectedToken && current.core_token !== token)) throw new Error('Core credential binding changed during renewal')
        if (expectedToken === token) return token
        // Compare and swap: a browser rebind while renewal was in flight must win.
        this.sessions.database.transaction(() => {
          const changed = db.prepare(`UPDATE mon_connections SET core_token=?,updated_at=? WHERE session_id=? AND core_token=? AND core_base_url=?
            AND EXISTS(SELECT 1 FROM mon_service_credentials WHERE session_id=? AND enabled=1)`)
            .run(token, Date.now(), sessionId, expectedToken, connection.coreBaseUrl, sessionId)
          if (changed.changes) this.renewed(sessionId, connection.coreBaseUrl, expectedToken, token)
        })
        expectedToken = token
        return token
      },
    } : undefined
    return new MonClient(connection.coreBaseUrl, connection.coreToken, credentials)
  }
  private matches(connection: MonConnection) {
    return this.identity && new URL(connection.coreBaseUrl).href.replace(/\/+$/, '') === new URL(this.identity.coreBaseUrl).href.replace(/\/+$/, '')
  }
  close() { this.abort.abort() }
}
