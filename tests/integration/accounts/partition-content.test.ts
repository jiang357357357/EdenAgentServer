import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { copyReferencedContent } from '../../../src/modules/accounts/partition-content.ts'

test('large history extracts references once and excludes unrelated content', { timeout: 15000 }, t => {
  const database = new EdenDatabase(':memory:', 'mon'), db = database.connection
  try {
    const session = new SessionRepository(database, 'mon').create('Synthetic import')
    db.exec(`ATTACH DATABASE ':memory:' AS legacy;
      CREATE TABLE legacy.blobs AS SELECT * FROM main.blobs;
      CREATE TABLE legacy.blob_owners AS SELECT * FROM main.blob_owners;
      CREATE TABLE legacy.request_contents AS SELECT * FROM main.request_contents;`)
    database.transaction(() => {
      const blob = db.prepare('INSERT INTO legacy.blobs VALUES(?,?,?,?,?)')
      const request = db.prepare('INSERT INTO legacy.request_contents VALUES(?,?)')
      for (let i = 0; i < 1000; i++) {
        blob.run(`blob-${i}`, `sha-${i}`, 'text/plain', 1, 0)
        request.run(`request-${i}`, '{}')
      }
      const event = db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
      const payload = JSON.stringify({ text: 'x'.repeat(4096) })
      for (let i = 0; i < 12000; i++) event.run(`event-${i}`, session.id, null, i + 2, 'agent.message_update', payload, 0)
      event.run('references', session.id, null, 12002, 'model.request', JSON.stringify({
        attachments: [{ blobId: 'blob-998' }], hash: 'request-997',
        requestStorage: { references: [{ hash: 'request-999' }] },
      }), 0)
    })
    const started = performance.now()
    copyReferencedContent(db, 'account-a')
    const elapsed = performance.now() - started
    t.diagnostic(`12,001 synthetic payloads / 2,000 content candidates: ${Math.round(elapsed)}ms`)
    assert.ok(elapsed < 8000, 'Reference extraction must not rescan history for each content candidate')
    assert.deepEqual(db.prepare('SELECT id FROM blobs').all().map(row => row.id), ['blob-998'])
    assert.deepEqual(db.prepare('SELECT hash FROM request_contents').all().map(row => row.hash), ['request-999'])
    assert.equal(db.prepare('SELECT account_key FROM blob_owners').get()?.account_key, 'account-a')
  } finally { database.close() }
})
