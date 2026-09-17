import { currentAccount } from '../accounts/index.ts'
import { AccountResources } from '../accounts/index.ts'
import { randomUUID } from 'node:crypto'
import { blobInfoSchema, type BlobInfo } from '@eden/api'
import type { EdenDatabase } from '@eden/store'

export class BlobRepository {
  constructor(private readonly database: EdenDatabase) {}

  put(sha256: string, mime: string, byteLength: number): BlobInfo {
    const candidate = blobInfoSchema.parse({ id: randomUUID(), sha256, mime, byteLength, createdAt: Date.now() })
    return this.database.transaction(() => {
      this.database.connection.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?, ?, ?, ?)')
        .run(candidate.id, candidate.sha256, candidate.mime, candidate.byteLength, candidate.createdAt)
      const row = this.database.connection.prepare('SELECT id FROM blobs WHERE sha256 = ?').get(sha256)
      const account = currentAccount()
      if (account) this.database.connection.prepare('INSERT OR IGNORE INTO blob_owners VALUES(?,?)').run(String(row?.id), account.key)
      const result = this.read(String(row?.id))
      if (!result || result.byteLength !== byteLength) throw new Error('Blob metadata integrity failure')
      return result
    })
  }

  read(id: string): BlobInfo | undefined {
    if (currentAccount() && !new AccountResources(this.database).blobVisible(id)) return undefined
    const row = this.database.connection.prepare(
      'SELECT id, sha256, mime, byte_length AS byteLength, created_at AS createdAt FROM blobs WHERE id = ?',
    ).get(id)
    return row ? blobInfoSchema.parse(row) : undefined
  }
}
