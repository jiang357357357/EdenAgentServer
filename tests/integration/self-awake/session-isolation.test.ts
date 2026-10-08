import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { serviceSignature } from '@eden/integrations'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { SelfAwakeBridgeRepository } from '../../../src/modules/self-awake/bridge-repository.ts'
import { SelfAwakeBridge } from '../../../src/modules/self-awake/bridge.ts'
import { publishWakeActivation } from '../../../src/modules/self-awake/activation-publication.ts'
import { wakeDeadline, maxWakeIntervalMs } from '../../../src/modules/self-awake/deadline.ts'
import { SelfAwakeHttp } from '../../../src/transport/http/self-awake.ts'
import { SelfAwakeService } from '../../../src/modules/self-awake/service.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-session-wakes-')), db = new EdenDatabase(':memory:', 'mon')
  const identity = { coreBaseUrl: 'http://127.0.0.1:1234', userId: '2', secret: 'fixture-only' }
  const account = { ...identity, key: accountKey(identity.coreBaseUrl, identity.userId) }
  const sessions = new SessionRepository(db, 'mon'), jobs = new JobRepository(db, true)
  const create = () => withAccount(account, () => sessions.create('test', [{ assistantId: 1 }]))
  const a = create(), b = create(), state = path.join(root, 'state.json')
  writeFileSync(state, JSON.stringify({ enabled: true, next_wake_at: null, wake_anchor_at: new Date(0).toISOString() }))
  writeFileSync(path.join(root, 'session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true, expiresAt: Date.now() + 30000 }))
  const repo = new SelfAwakeRepository(db, state), store = new SelfAwakeBridgeRepository(db, jobs)
  const bridge = new SelfAwakeBridge(identity, store, { repository: sessions } as never, null as never)
  t.after(async () => { await bridge.close(); db.close(); rmSync(root, { recursive: true, force: true }) })
  const plan = (sessionId: string, key = randomUUID()) => jobs.schedule({ kind: 'self_awake', sessionId, dueAt: Date.now() - 1, payload: {}, key, causationId: '', depth: 0 })
  const request = (sessionId: string, jobId?: string, key = randomUUID()) => ({ schema_version: 'self-awake.v2', user_id: '2', session_id: sessionId,
    ...(jobId ? { scheduled_job_id: jobId } : {}), event_id: key, idempotency_key: key, context: { type: 'scheduled' } })
  const scope = (sessionId: string) => path.join(root, 'sessions', sessionId)
  const requests = (sessionId: string) => readdirSync(path.join(scope(sessionId), 'schedule_requests')).map(name => JSON.parse(readFileSync(path.join(scope(sessionId), 'schedule_requests', name), 'utf8')))
  return { db, root, state, repo, bridge, store, jobs, sessions, account, a, b, plan, request, scope, requests }
}

test('A running does not block B; replacement, deferral and recovery remain session-owned', async t => {
  const f = fixture(t), a = f.plan(f.a.id), b = f.plan(f.b.id)
  await f.bridge.submit(f.request(f.a.id, a.id)); await f.bridge.submit(f.request(f.b.id, b.id))
  const claimed = [f.jobs.claim()!, f.jobs.claim()!]
  assert.deepEqual(new Set(claimed.map(job => job.id)), new Set([a.id, b.id]))
  const a2 = f.plan(f.a.id)
  f.jobs.defer(a.id, 'a busy'); f.jobs.defer(b.id, 'b waiting')
  assert.equal(f.jobs.read(a.id).state, 'cancelled')
  assert.equal(f.jobs.read(b.id).state, 'queued')
  f.jobs.recover()
  assert.equal(f.jobs.read(a2.id).state, 'queued')
  assert.equal(f.jobs.read(b.id).state, 'queued')
})

test('v2 activates the original approved job, deduplicates lost responses and rejects foreign session/account', async t => {
  const f = fixture(t), a = f.plan(f.a.id), b = f.plan(f.b.id), request = f.request(f.a.id, a.id)
  const result = await f.bridge.submit(request)
  assert.equal((result as { job_id: string }).job_id, a.id)
  assert.deepEqual(await f.bridge.submit(request), result)
  assert.equal(f.jobs.read(b.id).state, 'queued')
  await assert.rejects(f.bridge.submit(f.request(f.a.id, b.id)), /does not belong/)
  const foreign = withAccount({ ...f.account, userId: '3', key: accountKey(f.account.coreBaseUrl, '3') }, () => f.sessions.create('foreign', [{}]))
  await assert.rejects(f.bridge.submit(f.request(foreign.id)), /不属于/)
  await assert.rejects(f.bridge.submit({ ...f.request(f.a.id), user_id: '3' }), /user mismatch/)
  assert.equal(f.jobs.list().length, 2)
})

test('scoped wake coalescing excludes legacy and another session; closed scopes never create fallback jobs', async t => {
  const f = fixture(t)
  const a = await f.bridge.submit(f.request(f.a.id)) as { job_id: string }
  const b = await f.bridge.submit(f.request(f.b.id)) as { job_id: string }
  assert.notEqual(a.job_id, b.job_id)
  assert.equal((await f.bridge.submit(f.request(f.a.id)) as { job_id: string }).job_id, a.job_id)
  assert.equal(f.store.coalesce('2', 'legacy', 'hash'), undefined)
  f.db.connection.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(f.a.id)
  await assert.rejects(f.bridge.submit(f.request(f.a.id)), /closed/)
  assert.equal(f.jobs.read(b.job_id).state, 'queued')
})

test('durable publication/cancel isolates scope paths and retries only the failed scope', t => {
  const f = fixture(t), a = f.plan(f.a.id), b = f.plan(f.b.id)
  mkdirSync(f.scope(f.a.id), { recursive: true }); writeFileSync(path.join(f.scope(f.a.id), 'schedule_requests'), 'blocked')
  f.repo.timerPublication.publish(f.b.id)
  assert.equal(f.requests(f.b.id)[0].job_id, b.id)
  assert.throws(() => f.repo.timerPublication.publish(f.a.id), /delivery pending/)
  const pending = () => f.db.connection.prepare('SELECT session_id FROM self_awake_session_schedules WHERE published_revision<revision').all().map(row => row.session_id)
  assert.deepEqual(pending(), [f.a.id])
  rmSync(path.join(f.scope(f.a.id), 'schedule_requests')); f.repo.timerPublication.publish()
  assert.deepEqual(pending(), [])
  f.jobs.cancel(a.id); f.repo.timerPublication.publish()
  const latest = f.requests(f.a.id).sort((x, y) => x.revision - y.revision).at(-1)
  assert.equal(latest.action, 'cancel'); assert.equal(latest.job_id, null)
  assert.equal(f.requests(f.b.id).length, 1)
  assert.equal(existsSync(path.join(f.root, 'schedule_requests')), false)
})

test('actual activation, deadline and context do not borrow the legacy or other-session anchor', t => {
  const f = fixture(t), a = f.plan(f.a.id), b = f.plan(f.b.id)
  const ar = f.repo.begin(a, {}, {}), br = f.repo.begin(b, {}, {}), at = randomUUID(), bt = randomUUID()
  f.db.connection.prepare('UPDATE self_awake_runs SET turn_id=? WHERE id=?').run(at, ar)
  f.db.connection.prepare('UPDATE self_awake_runs SET turn_id=? WHERE id=?').run(bt, br)
  f.sessions.events.append(f.a.id, at, 'agent.agent_start', {})
  f.sessions.events.append(f.b.id, bt, 'agent.agent_start', {})
  f.db.connection.prepare("UPDATE events SET created_at=100 WHERE session_id=? AND kind='agent.agent_start'").run(f.a.id)
  f.db.connection.prepare("UPDATE events SET created_at=200 WHERE session_id=? AND kind='agent.agent_start'").run(f.b.id)
  assert.equal(wakeDeadline(f.db, f.state, 1000, f.a.id), 100 + maxWakeIntervalMs)
  assert.equal(wakeDeadline(f.db, f.state, 1000, f.b.id), 200 + maxWakeIntervalMs)
  publishWakeActivation(f.db, f.state)
  assert.equal(existsSync(path.join(f.root, 'agent_activation.json')), false)
  f.repo.timerPublication.publish()
  assert.equal(JSON.parse(readFileSync(path.join(f.scope(f.a.id), 'agent_activation.json'), 'utf8')).run_id, ar)
  assert.equal(f.repo.context(f.a.id, at).wakeSchedule?.status, 'unscheduled')
  assert.equal(f.db.connection.prepare('PRAGMA foreign_key_check').all().length, 0)
})

test('an old MonOs cannot accept isolated timers and a closed session cancellation survives recreation', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, 'session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true, expiresAt: Date.now() - 1 }))
  assert.throws(() => f.repo.timerPublication.assertAvailable(true), /MonOs/)
  rmSync(path.join(f.root, 'session-protocol.json'))
  assert.throws(() => f.repo.timerPublication.assertAvailable(true), /MonOs/)
  const a = f.plan(f.a.id), b = f.plan(f.b.id)
  f.db.connection.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(f.a.id)
  const row = f.db.connection.prepare('SELECT job_id,revision,published_revision FROM self_awake_session_schedules WHERE session_id=?').get(f.a.id)!
  assert.equal(row.job_id, null); assert.ok(Number(row.revision) > Number(row.published_revision))
  assert.equal(f.jobs.read(a.id).state, 'cancelled'); assert.equal(f.jobs.read(b.id).state, 'queued')
})

test('real signed HTTP v2 requests target two existing sessions without consulting the global current character', async t => {
  const f = fixture(t), a = f.plan(f.a.id), b = f.plan(f.b.id), handler = new SelfAwakeHttp('mon', f.bridge)
  const server = createServer((req, res) => { if (!handler.handle(req, res)) res.writeHead(404).end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const route = '/internal/self-awake/run', endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}${route}`
  const send = async (request: unknown) => {
    const body = Buffer.from(JSON.stringify(request)), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID()
    const result = await fetch(endpoint, { method: 'POST', body, headers: { 'x-mon-service-id': 'monos', 'x-mon-service-scope': 'self_awake:submit',
      'x-mon-service-timestamp': timestamp, 'x-mon-service-nonce': nonce,
      'x-mon-service-signature': serviceSignature(f.bridge.identity.secret, 'monos', 'self_awake:submit', timestamp, nonce, route, body) } })
    assert.equal(result.status, 200); return await result.json() as { job_id: string }
  }
  const [ar, br] = await Promise.all([send(f.request(f.a.id, a.id)), send(f.request(f.b.id, b.id))])
  assert.equal(ar.job_id, a.id); assert.equal(br.job_id, b.id)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 2)
})

test('a malformed completion is failed per run while the next session completes and scheduling remains active', async t => {
  const f = fixture(t), a = f.plan(f.a.id), b = f.plan(f.b.id), ar = f.repo.begin(a, {}, {}), br = f.repo.begin(b, {}, {})
  f.db.connection.prepare("UPDATE self_awake_runs SET state='running',request_json='{' WHERE id=?").run(ar)
  f.db.connection.prepare("UPDATE self_awake_runs SET state='running' WHERE id=?").run(br)
  const pending = [{ id: ar, inputId: 'a', state: 'completed', turnId: randomUUID() }, { id: br, inputId: 'b', state: 'completed', turnId: randomUUID() }]
  t.mock.method(f.repo, 'pendingResults', () => pending)
  t.mock.method(f.repo, 'finalText', () => '本会话完成')
  const service = new SelfAwakeService(f.repo, f.jobs, { repository: f.sessions } as never)
  t.after(() => service.close()); service.start(); await setImmediate()
  assert.equal(f.db.connection.prepare('SELECT state FROM self_awake_runs WHERE id=?').get(ar)?.state, 'failed')
  assert.equal(f.repo.read(br).status, 'completed')
  assert.equal(service.fault, undefined)
})
