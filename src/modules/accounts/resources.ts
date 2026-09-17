import type { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import { SessionOwnership } from './ownership.ts'
import { currentAccount } from './context.ts'

const sessionKeys = new Set(['sessionId', 'sessionID', 'sourceSessionId', 'boundSessionId', 'relatedSessionId', 'parentSessionId', 'rootSessionId', 'childSessionId', 'senderSessionId'])
const referenceKeys = new Set(['id', 'requestId', 'operationId', 'runId', 'agentId', 'jobId', 'inputId', 'messageId', 'eventId', 'previewId'])
/** Resolve persisted references as well as explicit session IDs; a supplied session ID is not proof of ownership. */
export class AccountResources {
  private readonly references: { table: string; column: string }[]
  private readonly ownership: SessionOwnership
  constructor(private readonly database: EdenDatabase) {
    this.ownership = new SessionOwnership(database)
    const tables = database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    this.references = tables.flatMap(row => {
      const table = String(row.name)
      if (!/^[a-z_]+$/.test(table)) return []
      const columns = database.connection.prepare(`PRAGMA table_info(${table})`).all()
      if (!columns.some(column => column.name === 'id' && column.type === 'TEXT')) return []
      return database.connection.prepare(`PRAGMA foreign_key_list(${table})`).all()
        .filter(key => key.table === 'sessions').map(key => ({ table, column: String(key.from) }))
    })
  }
  assert(value: JsonValue): void {
    if (!this.visible(value)) throw new Error('资源不存在或不属于当前账号')
  }
  visible(value: JsonValue): boolean {
    if (!currentAccount() || !value || typeof value !== 'object') return true
    if (Array.isArray(value)) return value.every(item => this.visible(item))
    return Object.entries(value).every(([key, item]) => {
      if (sessionKeys.has(key) && typeof item === 'string' && item !== '' && !this.ownership.visible(item)) return false
      if (referenceKeys.has(key) && typeof item === 'string' && !this.referenceVisible(item)) return false
      if (key === 'blobId' && typeof item === 'string' && !this.blobVisible(item)) return false
      return this.visible(item)
    })
  }
  filter(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.filter(item => this.visible(item)).map(item => this.filter(item))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.filter(item)]))
  }
  blobVisible(id: string): boolean {
    const key = currentAccount()?.key
    if (!key) return true
    if (this.database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value === key) return true
    if (this.database.connection.prepare('SELECT 1 FROM blob_owners WHERE blob_id=? AND account_key=?').get(id, key)) return true
    // Existing attachments are granted through durable references in an owned session, not filename or hash guessing.
    return Boolean(this.database.connection.prepare(`SELECT 1 FROM events e JOIN session_owners o ON o.session_id=e.session_id,
      json_tree(e.payload_json) j WHERE o.account_key=? AND j.value=? AND j.key IN ('blobId','id') LIMIT 1`).get(key, id))
  }
  private referenceVisible(id: string): boolean {
    for (const { table, column } of this.references) {
      const rows = this.database.connection.prepare(`SELECT ${column} AS session_id FROM ${table} WHERE id=?`).all(id)
      if (rows.some(row => row.session_id === null || !this.ownership.visible(String(row.session_id)))) return false
    }
    if (this.database.connection.prepare('SELECT 1 FROM blobs WHERE id=?').get(id)) return this.blobVisible(id)
    return true
  }
}
