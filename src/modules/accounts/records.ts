import type { EdenDatabase } from '@eden/store'
import { accountFilter, currentAccount } from './context.ts'
import { SessionOwnership } from './ownership.ts'

type RecordKind = 'memo' | 'memory'
export function recordFilter(database: EdenDatabase, kind: RecordKind, column: string): string {
  accountFilter(database, 'NULL')
  return `(eden_account() IS NULL OR ${column} IN (SELECT record_id FROM account_records WHERE kind='${kind}' AND account_key=eden_account()))`
}
export function ownRecord(database: EdenDatabase, kind: RecordKind, id: number, sourceSessionId?: string | null): void {
  const ownership = new SessionOwnership(database)
  if (sourceSessionId) ownership.assert(sourceSessionId)
  const owner = currentAccount()?.key ?? (sourceSessionId ? ownership.owner(sourceSessionId) : undefined)
  if (owner) database.connection.prepare('INSERT INTO account_records(kind,record_id,account_key) VALUES(?,?,?)').run(kind, id, owner)
}
