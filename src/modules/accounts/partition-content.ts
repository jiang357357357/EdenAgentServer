import type { DatabaseSync } from 'node:sqlite'

/** Parse each owned event once, then use indexed reference lookups instead of scanning events per object. */
export function copyReferencedContent(db: DatabaseSync, accountKey: string): void {
  db.exec(`CREATE TEMP TABLE account_content_refs(kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,value)) WITHOUT ROWID;
    INSERT OR IGNORE INTO account_content_refs
    SELECT CASE WHEN j.key='hash' THEN 'request' ELSE 'blob' END,j.value
    FROM main.events e,json_tree(e.payload_json) j
    WHERE j.type='text' AND (j.key IN ('blobId','id','audio_blob_id')
      OR (j.key='hash' AND j.path LIKE '$.requestStorage.references[%]'))`)
  try {
    db.prepare(`INSERT OR IGNORE INTO main.blobs SELECT * FROM legacy.blobs b WHERE b.id IN (
      SELECT blob_id FROM legacy.blob_owners WHERE account_key=?
      UNION SELECT blob_id FROM main.voice_audio_cache
      UNION SELECT value FROM account_content_refs WHERE kind='blob')`).run(accountKey)
    db.prepare('INSERT INTO main.blob_owners SELECT id,? FROM main.blobs').run(accountKey)
    db.exec(`INSERT OR IGNORE INTO main.request_contents SELECT * FROM legacy.request_contents
      WHERE hash IN (SELECT value FROM account_content_refs WHERE kind='request')`)
  } finally { db.exec('DROP TABLE account_content_refs') }
}
