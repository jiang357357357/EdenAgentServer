import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { modelEnvironment } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionService } from '../src/modules/sessions/index.ts'
import { sessionRoutes } from '../src/transport/rpc/session.routes.ts'

const environment = { timezone: 'Asia/Shanghai', locale: 'zh-CN', location: { country: '中国', region: '海南省', city: '儋州市',
  source: 'manual_map', updated_at: '2026-09-20T08:15:00+08:00', accuracy: 25, latitude: 31.234567, longitude: 121.456789 } }

function requestEnvironment(request: unknown): ReturnType<typeof modelEnvironment> {
  const { messages } = request as { messages: Array<{ role: string; content: string }> }
  const content = messages.find(message => message.role === 'system')!.content
  return JSON.parse(content.slice(content.indexOf('\n{') + 1)).environment
}

test('environment updates commit with queued input, survive reopen, and reach the model without coordinates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-environment-'))
  const file = path.join(root, 'environment.sqlite')
  const model = await recordedModel([{ text: 'First' }, { text: 'Restored' }])
  let db = new EdenDatabase(file, 'local')
  let repository = new SessionRepository(db, 'local')
  let sessions = new SessionService(repository, model.config)
  try {
    const session = repository.create('Environment', [], { timezone: 'UTC' })
    const routes = sessionRoutes(sessions)
    db.connection.exec("CREATE TRIGGER reject_environment BEFORE INSERT ON events WHEN NEW.kind='session.environment_updated' BEGIN SELECT RAISE(ABORT, 'environment disk failure'); END")
    await assert.rejects(async () => routes['turn.start']!({ sessionId: session.id, text: 'Hello', environment, idempotencyKey: 'env' }), /environment disk failure/)
    assert.deepEqual(repository.read(session.id).environment, { timezone: 'UTC' })
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS count FROM inputs').get()?.count, 0)
    assert.equal(model.requests.length, 0)
    db.connection.exec('DROP TRIGGER reject_environment')
    await routes['turn.start']!({ sessionId: session.id, text: 'Hello', environment, idempotencyKey: 'env' })
    await sessions.waitForIdle(session.id)
    await routes['turn.start']!({ sessionId: session.id, text: 'Hello', environment, idempotencyKey: 'env' })
    await sessions.waitForIdle(session.id)
    assert.equal(repository.events.list(session.id).filter(event => event.kind === 'session.environment_updated').length, 1)
    assert.equal(model.requests.length, 1)
    assert.match(JSON.stringify(model.requests[0]), /Asia\/Shanghai|儋州市/)
    assert.match(JSON.stringify(model.requests[0]), /manual_map/)
    assert.match(JSON.stringify(model.requests[0]), /2026-09-20T08:15:00\+08:00/)
    assert.equal(requestEnvironment(model.requests[0])!.location!.accuracy, 25)
    assert.match(JSON.stringify(model.requests[0]), /位置为保存的资料快照/)
    assert.doesNotMatch(JSON.stringify(model.requests[0]), /latitude|longitude|31\.234567|121\.456789/)
    await sessions.close(); db.close()
    db = new EdenDatabase(file, 'local'); repository = new SessionRepository(db, 'local'); sessions = new SessionService(repository, model.config)
    assert.equal((repository.read(session.id).environment as { location: { latitude: number } }).location.latitude, environment.location.latitude)
    assert.equal((repository.read(session.id).environment as { location: { updated_at: string } }).location.updated_at, environment.location.updated_at)
    sessions.start(session.id, 'Use saved environment')
    await sessions.waitForIdle(session.id)
    assert.equal(sessions.faultCount(), 0)
    assert.match(JSON.stringify(model.requests[1]), /Asia\/Shanghai/)
    assert.match(JSON.stringify(model.requests[1]), /manual_map/)
    assert.match(JSON.stringify(model.requests[1]), /2026-09-20T08:15:00\+08:00/)
    assert.deepEqual(requestEnvironment(model.requests[1]), requestEnvironment(model.requests[0]))
    assert.doesNotMatch(JSON.stringify(model.requests[1]), /latitude|longitude|31\.234567|121\.456789/)
  } finally { await sessions.close(); db.close(); await model.close(); await rm(root, { recursive: true, force: true }) }
})
