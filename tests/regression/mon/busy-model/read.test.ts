import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { ModelService } from '../../../../src/modules/models/index.ts'
import { SessionRepository, SessionService } from '../../../../src/modules/sessions/index.ts'
import { MonBindingService } from '../../../../src/modules/mon/index.ts'
import { modelRoutes } from '../../../../src/transport/rpc/model.routes.ts'
import { accountKey, withAccount } from '../../../../src/modules/accounts/index.ts'

test('a running session exposes its bound model without allowing catalog reconfiguration or selection', async () => {
  const recorded = await recordedModel([{ wait: true }])
  const database = new EdenDatabase(':memory:', 'mon')
  const repository = new SessionRepository(database, 'mon')
  const models = new ModelService('mon')
  const sessions = new SessionService(repository, id => models.resolve(id))
  const mon = new MonBindingService(models, sessions)
  const routes = modelRoutes(models, sessions, mon)
  try {
    await withAccount({ key: accountKey('http://fixture.local', 'owner'), userId: 'owner', coreBaseUrl: 'http://fixture.local' }, async () => {
      const session = repository.create('Busy model read')
      models.bind(session.id, { entityId: 42, label: 'Recorded current model', model: { ...recorded.config, apiKey: 'private-fixture-key' } })
      try {
        sessions.start(session.id, 'Wait until cancelled')
        const deadline = Date.now() + 10000
        while (recorded.requests.length === 0 && sessions.isRunning(session.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(recorded.requests.length, 1)
        assert.equal(sessions.isRunning(session.id), true)
        const params = { sessionId: session.id, coreBaseUrl: 'http://127.0.0.1:1', coreToken: 'fixture-token' }
        await assert.rejects(Promise.resolve(routes['model.catalog']!(params)), /become idle/)
        await assert.rejects(Promise.resolve(routes['model.select']!({ ...params, aiEntityId: 43 })), /become idle/)
        const current = await routes['model.read']!({ sessionId: session.id }) as Record<string, unknown>
        assert.equal(current.label, 'Recorded current model')
        assert.equal(current.aiEntityId, 42)
        assert.equal(current.id, recorded.config.id)
        assert.equal(current.available, true)
        assert.doesNotMatch(JSON.stringify(current), /private-fixture-key|fixture-token|apiKey/)
        assert.equal(sessions.isRunning(session.id), true)
        assert.equal(models.read(session.id).aiEntityId, 42)
        assert.equal(repository.events.list(session.id).filter(event => event.kind === 'model.bound').length, 0)
        await assert.rejects(async () => withAccount({ key: accountKey('http://fixture.local', 'other'), userId: 'other', coreBaseUrl: 'http://fixture.local' },
          () => routes['model.read']!({ sessionId: session.id })), /不属于当前账号/)
      } finally { await sessions.cancel(session.id) }
    })
  } finally {
    await mon.close(); await sessions.close(); database.close()
    await recorded.close()
  }
})
