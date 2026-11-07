import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { runConnector, ConnectorRequestError } from '@eden/plugin-sdk/connector'
import { connectorFixture } from '../../connector-fixture.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { ConnectorWorkerRuntime } from '../../../src/modules/connectors/worker-runtime.ts'
import { launchComponent } from '../../../src/modules/connectors/launch-component.ts'
import { connectorInstanceTools } from '../../../src/modules/connectors/instance-tools.ts'
import { connectorEventTools } from '../../../src/modules/connectors/event-tools.ts'
import { connectorDiscoveryTools } from '../../../src/modules/connectors/discovery-tools.ts'
import { modelTool } from '../../../src/modules/tool-results/index.ts'
import { SelfAwakeRepository, SelfAwakeService } from '../../../src/modules/self-awake/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'

const account = (userId: string) => ({ userId, coreBaseUrl: 'http://localhost:40011', key: accountKey('http://localhost:40011', userId) })

test('model-visible connector detail includes declared query and action schemas', async t => {
  const f = await connectorFixture(t), key = f.enable(), sessions = new SessionRepository(f.database, 'local')
  const session = sessions.create('connector discovery')
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'discover', displayName: 'Discover',
    settings: { boundSessionId: session.id }, desiredState: 'disconnected' })
  const tool = modelTool(connectorDiscoveryTools(f.connectors, f.catalog, session.id)[0]!)
  const raw = await tool.execute({ connectorId: instance.id }, { callId: 'detail', signal: new AbortController().signal })
  const visible = tool.modelResult!(raw, { connectorId: instance.id }) as { queries: Record<string, unknown>; actions: Record<string, unknown> }
  assert.deepEqual(Object.keys(visible.queries).sort(), ['echo', 'read'])
  assert.deepEqual(Object.keys(visible.actions), ['publish'])
  assert.match(tool.description, /connectorId/)
})

test('event jobs preserve the planned wake, wait while disabled, and serialize with active wake work', async t => {
  const f = await connectorFixture(t), key = f.enable(), sessions = new SessionRepository(f.database, 'local')
  const session = sessions.create('event owner'), jobs = new JobRepository(f.database, true)
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'event', displayName: 'Event',
    settings: { boundSessionId: session.id, selfAwakeOnEvent: true }, desiredState: 'connected' })
  f.connectors.runtimeState(instance.id, instance.generation, 'connected', null)
  const plan = jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: Date.now() + 60_000,
    payload: {}, key: 'future-plan', causationId: '', depth: 0 })
  const event = f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'first', payload: { count: 1 } })
  assert.ok(event.jobId)
  assert.equal(jobs.read(plan.id).state, 'queued')
  assert.equal(jobs.read(event.jobId!).kind, 'connector.event')
  const stopped = new JobRepository(f.database, true, () => false)
  assert.equal(stopped.claim(), undefined)
  assert.equal(jobs.claim()?.id, event.jobId)
  const next = f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'second', payload: { count: 2 } })
  assert.equal(jobs.claim(), undefined)
  jobs.fail(event.jobId!, 'fixture completed')
  assert.equal(jobs.claim()?.id, next.jobId)
  assert.equal(jobs.read(plan.id).state, 'queued')
  assert.equal(f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'first', payload: { count: 1 } }).duplicate, true)
  assert.throws(() => f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'first', payload: { count: 9 } }), /different content/)
})

test('approved per-session sharing enforces account ownership, events paginate and revocation removes access', async t => {
  const f = await connectorFixture(t), key = f.enable(), sessions = new SessionRepository(f.database, 'local')
  const alice = account('alice'), bob = account('bob')
  const owner = withAccount(alice, () => sessions.create('owner')), target = withAccount(alice, () => sessions.create('target'))
  const foreign = withAccount(bob, () => sessions.create('foreign'))
  const instance = withAccount(alice, () => f.connectors.create({ connectorKey: key, identityKey: 'shared', displayName: 'Shared',
    settings: { boundSessionId: owner.id }, desiredState: 'connected' }))
  f.connectors.runtimeState(instance.id, instance.generation, 'connected', null)
  const permissions = new PermissionService(f.database, sessions.events)
  const tool = connectorInstanceTools(f.connectors, f.catalog, f.grants, sessions, permissions, owner.id, owner.id)[0]!
  const stop = sessions.events.subscribe(event => {
    if (event.kind === 'permission.requested') queueMicrotask(() => {
      for (const request of permissions.list(owner.id).filter(item => item.state === 'pending')) permissions.resolve(request.id, true)
    })
  })
  t.after(stop)
  const call = (action: string, targetSessionId: string) => withAccount(alice, () => tool.execute({ action, connectorId: instance.id, targetSessionId },
    { callId: `${action}-${targetSessionId}`, signal: new AbortController().signal }))
  await assert.rejects(call('share', foreign.id), /账号|account/i)
  await call('share', target.id)
  assert.equal(withAccount(alice, () => f.connectors.accessible(instance.id, target.id)), true)
  const ids = [1, 2, 3].map(count => f.events.accept(instance.id, instance.generation,
    { eventType: 'changed', externalId: `id-${count}`, payload: { count } }).id)
  const first = withAccount(alice, () => f.events.listForSession(target.id, { after: 0, limit: 2 }))
  assert.deepEqual(first.events.map(event => event.id), ids.slice(0, 2))
  assert.equal(first.hasMore, true)
  const second = withAccount(alice, () => f.events.listForSession(target.id, { after: first.nextCursor!, limit: 2 }))
  assert.deepEqual(second.events.map(event => event.id), ids.slice(2))
  assert.equal(second.hasMore, false)
  assert.deepEqual((withAccount(alice, () => f.events.readForSession(target.id, ids[0]!)) as { payload: unknown }).payload, { count: 1 })
  await call('unshare', target.id)
  assert.equal(withAccount(alice, () => f.connectors.accessible(instance.id, target.id)), false)
  assert.equal(withAccount(alice, () => f.events.listForSession(target.id, { after: 0 })).events.length, 0)
  assert.throws(() => withAccount(alice, () => f.events.readForSession(target.id, ids[0]!)), /not available/)
})

test('SDK confirmed publish waits for the host receipt and retries deduplicate without killing the channel', { timeout: 15000 }, async t => {
  const f = await connectorFixture(t), key = f.enable(), sessions = new SessionRepository(f.database, 'local')
  const session = sessions.create('worker event')
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'wire', displayName: 'Wire',
    settings: { boundSessionId: session.id }, desiredState: 'connected' })
  const toWorker = new PassThrough(), fromWorker = new PassThrough()
  const worker = runConnector({ id: 'arbitrary-weather', version: '1.0.0', events: ['changed'], queries: [], actions: ['publish', 'reject'],
    initialize: context => ({ health: () => ({ state: 'ready', initialized: true }), close() {},
      execute: async call => {
        if (call.capability === 'reject') throw new ConnectorRequestError('invalid_move', 'The position is occupied')
        return context.publishConfirmed('changed', call.operationId, call.payload)
      } }) }, toWorker, fromWorker)
  const runtime = new ConnectorWorkerRuntime(instance.id, instance.generation, toWorker, fromWorker, f.connectors, f.events,
    async () => { toWorker.destroy(); fromWorker.destroy(); await worker.catch(() => {}) }, undefined, 'arbitrary-weather')
  t.after(() => runtime.close())
  await runtime.initialize({ protocolVersion: 1, connectorInstanceId: instance.id, connectorKey: 'arbitrary-weather', packageVersion: '1.0.0',
    settings: instance.settings, grantedPermissions: [], dataDirectory: f.dataRoot })
  const signal = new AbortController().signal
  const first = await runtime.invoke('execute', 'publish', { value: 7 }, 'stable-event', signal) as { id: string; duplicate: boolean }
  const repeat = await runtime.invoke('execute', 'publish', { value: 7 }, 'stable-event', signal) as { id: string; duplicate: boolean }
  assert.equal(first.duplicate, false)
  assert.equal(repeat.duplicate, true)
  assert.equal(first.id, repeat.id)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM connector_events').get()?.count, 1)
  await assert.rejects(runtime.invoke('execute', 'reject', {}, 'rejected', signal), /invalid_move.*occupied/)
  assert.equal((await runtime.invoke('execute', 'publish', { value: 8 }, 'next-event', signal) as { duplicate: boolean }).duplicate, false)
})

test('installed connector process publishes a confirmed event to the durable host database', { timeout: 30000 }, async t => {
  const source = `import {runConnector} from '@eden/plugin-sdk/connector';
await runConnector({id:'arbitrary-weather',version:'1.0.0',events:['changed'],queries:[],actions:['publish'],
initialize(context){return {health:()=>({state:'ready',initialized:true}),close(){},
execute:async call=>await context.publishConfirmed('changed',call.operationId,call.payload)}}});`
  const f = await connectorFixture(t, [], source), key = f.enable(), sessions = new SessionRepository(f.database, 'local')
  const session = sessions.create('actual process')
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'confirmed-process', displayName: 'Confirmed',
    settings: { boundSessionId: session.id }, desiredState: 'connected' })
  const abort = new AbortController()
  const launched = await launchComponent(instance.id, f.dataRoot, f.connectors, f.catalog, f.grants, f.events, f.credentials, abort.signal)
  f.cleanup.push(() => launched.runtime.close())
  const receipt = await launched.runtime.invoke('execute', 'publish', { saved: true }, 'actual-process-event', abort.signal) as { id: string; duplicate: boolean }
  assert.equal(receipt.duplicate, false)
  assert.deepEqual((f.events.readForSession(session.id, receipt.id) as { payload: unknown }).payload, { saved: true })
  const duplicate = await launched.runtime.invoke('execute', 'publish', { saved: true }, 'actual-process-event', abort.signal) as { id: string; duplicate: boolean }
  assert.equal(duplicate.id, receipt.id)
  assert.equal(duplicate.duplicate, true)
})

test('typed events reject invalid payloads and committed event jobs survive database restart', async t => {
  const f = await connectorFixture(t, [], undefined, { persistent: true,
    eventSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } })
  const key = f.enable(), sessions = new SessionRepository(f.database, 'local'), session = sessions.create('persisted event')
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'persistent', displayName: 'Persistent',
    settings: { boundSessionId: session.id, selfAwakeOnEvent: true }, desiredState: 'connected' })
  f.connectors.runtimeState(instance.id, instance.generation, 'connected', null)
  assert.throws(() => f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'invalid', payload: { count: 'wrong' } }))
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM connector_events').get()?.count, 0)
  const receipt = f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'valid', payload: { count: 7 } })
  const reopened = new EdenDatabase(path.join(f.dataRoot, 'fixture.sqlite'), 'local')
  try {
    const jobs = new JobRepository(reopened)
    jobs.recover()
    assert.equal(jobs.read(receipt.jobId!).state, 'queued')
    const row = reopened.connection.prepare('SELECT payload_json,job_id FROM connector_events WHERE id=?').get(receipt.id)
    assert.deepEqual(JSON.parse(String(row?.payload_json)), { count: 7 })
    assert.equal(row?.job_id, receipt.jobId)
  } finally { reopened.close() }
})

test('connector event reaches an actual model turn and reads its durable event without replacing the timer', { timeout: 45000 }, async t => {
  const f = await connectorFixture(t), key = f.enable(), repository = new SessionRepository(f.database, 'local')
  const owner = repository.create('event model'), jobs = new JobRepository(f.database)
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'model', displayName: 'Model',
    settings: { boundSessionId: owner.id, selfAwakeOnEvent: true }, desiredState: 'connected' })
  f.connectors.runtimeState(instance.id, instance.generation, 'connected', null)
  const future = jobs.schedule({ kind: 'self_awake', sessionId: owner.id, dueAt: Date.now() + 60_000,
    payload: {}, key: 'model-future-plan', causationId: '', depth: 0 })
  const receipt = f.events.accept(instance.id, instance.generation, { eventType: 'changed', externalId: 'model-event', payload: { turn: 73 } })
  const model = await recordedModel([{ tool: 'read_connector_events', input: { eventId: receipt.id } }, { text: 'Event processed.' }])
  const permissions = new PermissionService(f.database, repository.events)
  permissions.setMode('full_access')
  const sessions = new SessionService(repository, model.config, (id, turnId) => connectorEventTools(f.events, permissions, id, turnId))
  const awake = new SelfAwakeRepository(f.database), service = new SelfAwakeService(awake, jobs, sessions)
  try {
    service.start()
    const claimed = jobs.claim()
    assert.equal(claimed?.id, receipt.jobId)
    service.dispatch(claimed!)
    await sessions.waitForIdle(owner.id)
    await nextTurn()
    jobs.settleInputs()
    assert.equal(jobs.read(receipt.jobId!).state, 'completed')
    assert.equal(jobs.read(future.id).state, 'queued')
    const messages = model.requests[1]!.messages as { role: string; content?: string }[]
    const toolReply = messages.find(message => message.role === 'tool')
    assert.deepEqual(JSON.parse(toolReply!.content!).payload, { turn: 73 })
    const run = f.database.connection.prepare('SELECT state FROM self_awake_runs WHERE job_id=?').get(receipt.jobId!)
    assert.equal(run?.state, 'completed')
    assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM self_awake_diaries').get()?.count, 0)
  } finally { service.close(); await sessions.close(); await model.close() }
})
