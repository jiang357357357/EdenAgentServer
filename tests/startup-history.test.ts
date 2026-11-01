import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
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

function writeV1Database(source: EdenDatabase, filename: string) {
  const previousVersion = migrations.findIndex(sql => sql.includes('eden.message.delta.v2'))
  assert.ok(previousVersion > 0)
  const legacy = new DatabaseSync(filename)
  try {
    for (const sql of migrations.slice(0, previousVersion)) legacy.exec(sql)
    legacy.exec('BEGIN')
    for (const row of legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = String(row.name)
      if (table === 'schema_migrations') continue
      const quoted = '"' + table.replaceAll('"', '""') + '"'
      const columns = legacy.prepare(`PRAGMA table_info(${quoted})`).all().map(field => String(field.name))
      const names = columns.map(name => '"' + name.replaceAll('"', '""') + '"').join(',')
      const insert = legacy.prepare(`INSERT OR REPLACE INTO ${quoted} (${names}) VALUES (${columns.map(() => '?').join(',')})`)
      for (const value of source.connection.prepare(`SELECT ${names} FROM ${quoted}`).all()) insert.run(...columns.map(name => value[name]!))
    }
    for (let version = 1; version <= previousVersion; version++) legacy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(version, Date.now())
    legacy.prepare("INSERT OR REPLACE INTO realm_meta VALUES('event_payload_format','eden.message.delta.v1')").run()
    legacy.exec(`PRAGMA user_version=${previousVersion}`)
    legacy.exec('COMMIT')
  } finally { legacy.close() }
}

test('Local host upgrades previous v1 history and recovers memories before serving health', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-startup-history-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const config = loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'local', EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' })
  const db = new EdenDatabase(config.databasePath, 'local')
  try {
    const sessions = new SessionRepository(db, 'local')
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
    const before = performance.now()
    await recoverMemoryExtractions(new MemoryExtractionRepository(db), new AbortController().signal)
    context.diagnostic(`Previous-format history recovery: ${Math.round(performance.now() - before)}ms`)
    // Build an actual previous schema; later memo/pin migrations must not be
    // pretended unapplied while their columns still exist in the fixture.
    writeV1Database(db, path.join(root, 'legacy.sqlite3'))
  } finally { db.close() }
  await rename(path.join(root, 'legacy.sqlite3'), config.databasePath)
  const started = performance.now()
  const server = await startServer(config)
  try {
    context.diagnostic(`Indexed host startup including migration: ${Math.round(performance.now() - started)}ms`)
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).runtimeOrigin, 'local')
    assert.equal(server.sessions.repository.database.connection.prepare('SELECT count(*) AS n FROM memory_extractions').get()?.n, 30)
    assert.equal(server.sessions.repository.database.connection.prepare("SELECT value FROM realm_meta WHERE key='event_payload_format'").get()?.value, 'eden.message.delta.v2')
    assert.equal(server.sessions.repository.database.connection.prepare("SELECT count(*) AS n FROM events WHERE kind='agent.message_update'").get()?.n, 12000)
    const before = performance.now()
    await recoverMemoryExtractions(new MemoryExtractionRepository(server.sessions.repository.database), new AbortController().signal)
    context.diagnostic(`Indexed recovery: ${Math.round(performance.now() - before)}ms`)
  } finally { await server.close() }
})
