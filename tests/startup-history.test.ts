import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { migrations } from '@eden/store/testing'
import { loadConfig } from '../src/bootstrap/config.ts'
import { startServer } from '../src/bootstrap/container.ts'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { InputRepository } from '../src/modules/sessions/input/input-repository.ts'
import { MemoryExtractionRepository } from '../src/modules/memories/extraction-repository.ts'
import { recoverMemoryExtractions } from '../src/modules/memories/extraction-recovery.ts'

test('Mon host upgrades a populated history and recovers memories before serving health', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-startup-history-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const config = loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_V2_DATA_ROOT: root, EDEN_AGENT_PORT: '0' })
  const db = new EdenDatabase(config.databasePath, 'mon')
  try {
    const sessions = new SessionRepository(db, 'mon')
    const inputs = new InputRepository(db, sessions.events)
    const participants = [{ assistantId: 1, characterId: 11 }]
    const session = sessions.create('Synthetic history', participants)
    for (let i = 0; i < 30; i++) {
      inputs.enqueue(session.id, 'Synthetic fact', String(i), { participants })
      const input = inputs.claim(session.id)!
      sessions.events.append(session.id, input.turnId, 'agent.message_end', { message: { role: 'assistant', content: 'Synthetic reply' } })
      inputs.finish(input)
    }
    db.transaction(() => {
      const insert = db.connection.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)')
      const payload = JSON.stringify({ delta: 'x'.repeat(4096) })
      for (let i = 0; i < 12000; i++) insert.run(`filler-${i}`, session.id, 'other-turn', 1000 + i, 'agent.message_update', payload, 0)
    })
    // Reproduce the preceding schema using synthetic data only.
    db.connection.exec('DROP INDEX events_session_kind_seq; DROP INDEX events_session_turn_kind_seq; DROP TABLE request_contents; DROP INDEX jobs_one_pending_self_awake; DROP TABLE self_awake_timer_publications; DROP TABLE self_awake_submission_aliases')
    const indexMigration = migrations.findIndex(sql => sql.includes('CREATE INDEX events_session_kind_seq'))
    db.connection.prepare('DELETE FROM schema_migrations WHERE version>?').run(indexMigration)
    db.connection.prepare("DELETE FROM realm_meta WHERE key='event_payload_format'").run()
    db.connection.exec(`PRAGMA user_version=${indexMigration}`)
    const before = performance.now()
    await recoverMemoryExtractions(new MemoryExtractionRepository(db), new AbortController().signal)
    context.diagnostic(`Unindexed recovery: ${Math.round(performance.now() - before)}ms`)
  } finally { db.close() }
  const started = performance.now()
  const server = await startServer(config)
  try {
    context.diagnostic(`Indexed host startup including migration: ${Math.round(performance.now() - started)}ms`)
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).runtimeOrigin, 'mon')
    assert.equal(server.sessions.repository.database.connection.prepare('SELECT count(*) AS n FROM memory_extractions').get()?.n, 30)
    const before = performance.now()
    await recoverMemoryExtractions(new MemoryExtractionRepository(server.sessions.repository.database), new AbortController().signal)
    context.diagnostic(`Indexed recovery: ${Math.round(performance.now() - before)}ms`)
  } finally { await server.close() }
})
