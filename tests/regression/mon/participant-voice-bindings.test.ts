import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EdenDatabase } from '@eden/store'
import { ModelService } from '../../../src/modules/models/index.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { MonBindingService } from '../../../src/modules/mon/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'

test('catalogue refresh repairs persisted voice bindings for existing single and multiple actors', async t => {
  let configured = true
  const entity = { id: 1, ai_model: 'fixture', vendor: 'openai', status: 'active', api_key: 'fixture-private',
    api_endpoint: 'http://127.0.0.1:1', default_params: { context_window: 32000, max_tokens: 1024 } }
  const core = createServer((request, response) => {
    const url = request.url ?? ''
    const id = url === '/api/assistants/current/' ? 9 : Number(url.split('/').filter(Boolean).at(-1))
    const value = url.startsWith('/api/assistants/') ? { id, name: `Actor ${id}`, character: { id: id * 10,
      name: `Character ${id}`, ai_talk_entity_id: 1, tts_config_id: configured ? id + 20 : null, stt_config_id: configured ? 7 : null } }
      : url === '/api/agent/settings/my/' ? {} : url === '/api/core/vendors/ai/' ? { vendors: {} }
      : url === '/api/ai/entities/' ? [entity] : entity
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const coreBaseUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`
  const db = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(db, 'mon')
  const models = new ModelService('mon'), sessions = new SessionService(repository, id => models.resolve(id))
  const mon = new MonBindingService(models, sessions)
  t.after(async () => { await mon.close(); await sessions.close(); db.close(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())) })
  await withAccount({ key: accountKey(coreBaseUrl, 'fixture-owner'), userId: 'fixture-owner', coreBaseUrl }, async () => {
    const profile = { character: { name: 'Conversation snapshot' } }
    const single = repository.create('Existing chat', [{ assistantId: 4, characterId: 40, ttsConfigId: null, sttConfigId: null, profile }])
    const multi = repository.create('Multiple actors', [{ assistantId: 3, ttsConfigId: 99 }, { assistantId: 4, ttsConfigId: null }])
    const refresh = (sessionId: string) => mon.catalog({ sessionId, coreBaseUrl, coreToken: 'fixture-token' })
    await refresh(single.id)
    const participant = repository.read(single.id).participants[0] as Record<string, unknown>
    assert.equal(participant.ttsConfigId, 24); assert.equal(participant.sttConfigId, 7)
    assert.deepEqual(participant.profile, profile)
    const count = repository.events.list(single.id).filter(event => event.kind === 'session.metadata.updated').length
    await refresh(single.id)
    assert.equal(repository.events.list(single.id).filter(event => event.kind === 'session.metadata.updated').length, count)
    await refresh(multi.id)
    assert.deepEqual(repository.read(multi.id).participants.map(value => (value as Record<string, unknown>).ttsConfigId), [23, 24])
    configured = false
    await refresh(single.id)
    const cleared = repository.read(single.id).participants[0] as Record<string, unknown>
    assert.equal(cleared.ttsConfigId, null); assert.equal(cleared.sttConfigId, null)
    assert.doesNotMatch(JSON.stringify(repository.events.list(single.id)), /fixture-private|fixture-token/)
  })
})
