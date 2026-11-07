// Explicit opt-in: uses the saved provider credentials and makes billable real-model requests.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { configuredPluginTestModel } from '../../../../Script/Test/live-plugin-model.mjs'
import { connectorFixture } from '../../connector-fixture.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { JobRepository, JobScheduler } from '../../../src/modules/jobs/index.ts'
import { SelfAwakeRepository, SelfAwakeService } from '../../../src/modules/self-awake/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { ConnectorLifecycle, connectorCapabilityTools, connectorDiscoveryTools, connectorEventTools } from '../../../src/modules/connectors/index.ts'
import { SessionCapabilities } from '../../../src/modules/capabilities/index.ts'
import { SkillRepository } from '../../../src/modules/skills/index.ts'
import type { JsonValue } from '@eden/api'

const source = `import {runConnector} from '@eden/plugin-sdk/connector';
import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';
await runConnector({id:'arbitrary-weather',version:'1.0.0',events:['requested'],queries:['get_state'],actions:['trigger','mark_done'],
initialize(context){const file=path.join(context.dataDirectory,'tasks.json');const read=async()=>{try{return JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return {itemId:'synthetic-1',done:false};throw e}};
return {health:()=>({state:'ready',initialized:true}),close(){},query:async()=>read(),execute:async call=>{
if(call.capability==='trigger')return context.publishConfirmed('requested',call.operationId,call.payload);
if(call.capability==='mark_done'){if(call.payload.itemId!=='synthetic-1')throw Error('Unknown item');const value={itemId:'synthetic-1',done:true};await writeFile(file,JSON.stringify(value));return value}
throw Error('Unknown action')}}}});`
const empty = { type: 'object', properties: {}, additionalProperties: false }
const object = (value: JsonValue | undefined): value is Record<string, JsonValue> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

test('real model processes a confirmed connector event through actual query and action', { timeout: 240000 }, async t => {
  const model = configuredPluginTestModel(process.cwd())
  const f = await connectorFixture(t, [], source, { capabilities: {
    events: { requested: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false } },
    queries: { get_state: empty }, actions: { trigger: empty,
      mark_done: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'], additionalProperties: false } },
  } })
  const key = f.enable(), repository = new SessionRepository(f.database, 'local'), session = repository.create('Synthetic connector model acceptance')
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'synthetic', displayName: 'Synthetic task connector',
    settings: { boundSessionId: session.id, selfAwakeOnEvent: true }, desiredState: 'connected' })
  const lifecycle = new ConnectorLifecycle(f.dataRoot, f.connectors, f.catalog, f.grants, f.events, f.credentials)
  const jobs = new JobRepository(f.database), permissions = new PermissionService(f.database, repository.events)
  permissions.setMode('full_access')
  const skills = new SkillRepository(f.database)
  const sessions = new SessionService(repository, model, (id, turnId) => new SessionCapabilities(f.database, repository.events, skills,
    () => ({ sessionId: id, owner: 'synthetic', profile: 'user_chat', workspaceRoot: '', sourceChannel: 'app' }), () => [
      ...connectorDiscoveryTools(f.connectors, f.catalog, id), ...connectorEventTools(f.events, permissions, id, turnId),
      ...connectorCapabilityTools(f.database, f.connectors, f.catalog, lifecycle, permissions, id, turnId),
    ]).registeredTools())
  const awake = new SelfAwakeService(new SelfAwakeRepository(f.database), jobs, sessions)
  const scheduler = new JobScheduler(jobs, { 'connector.event': job => awake.dispatch(job), self_awake: job => awake.dispatch(job) })
  let requests = 0
  const unsubscribe = repository.events.subscribe(event => { if (event.sessionId === session.id && event.kind === 'model.request') requests++ })
  try {
    lifecycle.start(); awake.start(); scheduler.start()
    const future = jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: Date.now() + 3600000,
      key: 'synthetic-future-plan', causationId: '', depth: 0, payload: {} })
    const deadline = Date.now() + 20000
    while (f.connectors.read(instance.id).runtimeState !== 'connected' && Date.now() < deadline) await delay(100)
    assert.equal(f.connectors.read(instance.id).runtimeState, 'connected', 'Fixture connector did not start')
    const signal = new AbortController().signal
    const receipt = await lifecycle.invoke(instance.id, instance.generation, 'execute', 'trigger',
      { task: '请使用连接器读取待办状态，将唯一的待办标记为完成。先检查状态，按连接器声明的能力执行。' }, 'synthetic-request', signal) as { id: string; jobId: string | null }
    assert.ok(receipt.jobId, 'Event did not produce an autonomous job')
    console.log('Live model request started; waiting for the connector event job')
    const finishBy = Date.now() + 180000
    while (Date.now() < finishBy && !['completed', 'failed', 'cancelled', 'unknown'].includes(jobs.read(receipt.jobId!).state)) await delay(500)
    const job = jobs.read(receipt.jobId!)
    assert.equal(job.state, 'completed', `Event job ended as ${job.state}: ${job.error ?? ''}`)
    const final = await lifecycle.invoke(instance.id, instance.generation, 'query', 'get_state', {}, 'verify-state', signal)
    const toolTrace = f.database.connection.prepare('SELECT tool_name,state FROM tool_operations WHERE session_id=? ORDER BY created_at').all(session.id)
    const messages = repository.events.list(session.id, '0', 1000).filter(event => event.kind === 'agent.message_end')
      .map(event => event.payload).filter(object).map(value => value.message).filter(object).filter(value => value.role === 'assistant')
    const last = messages.at(-1), finalText = last && Array.isArray(last.content)
      ? last.content.filter(object).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : ''
    console.log(JSON.stringify({ requests, toolTrace, finalText: finalText.replaceAll(model.apiKey, '[redacted]').slice(0, 1500), finalState: final }))
    assert.deepEqual(final, { itemId: 'synthetic-1', done: true }, 'Model did not complete the synthetic task')
    assert.equal(jobs.read(future.id).state, 'queued', 'Event replaced the existing wake plan')
    const operations = f.database.connection.prepare("SELECT method,state FROM connector_operations WHERE connector_id=? ORDER BY created_at").all(instance.id)
    assert.ok(operations.some(operation => operation.method === 'execute' && operation.state === 'completed'), 'No completed model action was recorded')
    assert.ok(requests > 0, 'No actual model request was recorded')
    console.log(JSON.stringify({ passed: true, provider: model.provider, model: model.id, modelRequests: requests,
      eventConfirmed: true, jobState: job.state, connectorOperations: operations.map(operation => ({ method: operation.method, state: operation.state })),
      finalState: final, originalTimer: 'queued', userBusinessDataUsed: false, liveModel: true }))
  } finally {
    unsubscribe(); scheduler.close(); awake.close(); await sessions.close(); await lifecycle.close()
  }
})
