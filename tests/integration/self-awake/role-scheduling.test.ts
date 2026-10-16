import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { SelfAwakeRepository, SelfAwakeRoleSessions } from '../../../src/modules/self-awake/index.ts'
import { SelfAwakeBridgeRepository } from '../../../src/modules/self-awake/bridge-repository.ts'
import { SelfAwakeBridge } from '../../../src/modules/self-awake/bridge.ts'
import { selfAwakePromptContext } from '../../../src/modules/self-awake/prompt.ts'
import { publishWakeActivation } from '../../../src/modules/self-awake/activation-publication.ts'
import { wakeDeadline, maxWakeIntervalMs } from '../../../src/modules/self-awake/deadline.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'

function fixture(t: test.TestContext) {
  const db = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(db, 'mon'), jobs = new JobRepository(db, true)
  const root = mkdtempSync(path.join(tmpdir(), 'eden-role-clock-')), state = path.join(root, 'state.json')
  writeFileSync(path.join(root, 'session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true, roleScopes: true, expiresAt: Date.now() + 60000 }))
  const repo = new SelfAwakeRepository(db, state, true)
  const account = (user = '2') => ({ coreBaseUrl: 'http://127.0.0.1:1', userId: user, key: accountKey('http://127.0.0.1:1', user) })
  const create = (characterId = 4, user = '2', purpose: 'self_awake' | 'user_chat' = 'self_awake') => withAccount(account(user), () => sessions.create('fixture',
    [{ assistantId: characterId, characterId }], { sessionPurpose: purpose, selfAwakeUserId: user }, { purpose, sourceChannel: purpose === 'self_awake' ? 'internal' : 'app' }))
  const plan = (id: string, dueAt = Date.now() + 60000, reason = 'fixture', kind = 'self_awake') => jobs.schedule({ kind, sessionId: id,
    dueAt, payload: { prompt: reason, ...repo.roles.payload(id) }, key: randomUUID(), causationId: '', depth: 0 })
  t.after(() => { repo.timerPublication.close(); db.close(); rmSync(root, { recursive: true, force: true }) })
  const requests = (id: string) => readdirSync(path.join(root, 'sessions', id, 'schedule_requests')).map(name => JSON.parse(readFileSync(path.join(root, 'sessions', id, 'schedule_requests', name), 'utf8')))
  return { db, sessions, jobs, root, state, repo, account, create, plan, requests }
}

test('seven legacy loops become one clock, preserve all reasons, retire six scopes and survive repeated startup', t => {
  const f = fixture(t), now = Date.now(), legacy = Array.from({ length: 7 }, () => f.create())
  const plans = legacy.map((s, i) => f.plan(s.id, now + (i + 1) * 60000, `旧事项 ${i}`))
  const memo = f.plan(legacy[0]!.id, now + 1000, '明确提醒', 'memo.reminder')
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const queued = f.jobs.list({ state: 'queued' }).filter(j => j.kind === 'self_awake')
  assert.equal(queued.length, 1); assert.equal(queued[0]!.dueAt, now + 60000)
  const target = queued[0]!.sessionId!
  assert.equal(new Set(legacy.map(s => f.repo.roles.target(s.id))).size, 1)
  assert.equal(f.repo.roles.merged(target).length, 7)
  assert.deepEqual(f.repo.roles.merged(target).map(p => p.reason), plans.map((_, i) => `旧事项 ${i}`))
  assert.equal(f.jobs.read(memo.id).state, 'queued')
  assert.ok(plans.every(p => f.jobs.read(p.id).state === 'cancelled'))
  f.repo.timerPublication.publish()
  for (const session of legacy) {
    const latest = f.requests(session.id).sort((a, b) => a.revision - b.revision).at(-1)!
    assert.equal(latest.action, session.id === target ? 'schedule' : 'cancel')
    assert.equal(latest.scope_kind, session.id === target ? 'role' : 'retired')
  }
  const before = f.db.connection.prepare('SELECT * FROM self_awake_session_schedules ORDER BY session_id').all()
  f.repo.roles.reconcile(f.sessions, f.jobs)
  assert.deepEqual(f.db.connection.prepare('SELECT * FROM self_awake_session_schedules ORDER BY session_id').all(), before)
  assert.equal(f.jobs.list({ state: 'queued' }).filter(j => j.kind === 'self_awake')[0]?.id, queued[0]!.id)
  assert.equal(f.db.connection.prepare('PRAGMA foreign_key_check').all().length, 0)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 7)
})

test('accounts and characters keep independent clocks and an account-scoped reconciliation cannot touch another owner', t => {
  const f = fixture(t), a = f.create(), b = f.create(5), other = f.create(4, '3')
  f.plan(a.id); f.plan(b.id); f.plan(other.id)
  withAccount(f.account(), () => f.repo.roles.reconcile(f.sessions, f.jobs))
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_role_scopes').get()?.n, 2)
  assert.equal(f.repo.roles.schedulerKind(other.id), 'session_task')
  withAccount(f.account('3'), () => f.repo.roles.reconcile(f.sessions, f.jobs))
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_role_scopes').get()?.n, 3)
  assert.notEqual(f.repo.roles.payload(a.id).roleScope, f.repo.roles.payload(other.id).roleScope)
})

test('an unresolved old execution occupies its role slot; another role and reminders still dispatch', t => {
  const f = fixture(t), old = f.create(), target = f.create(), other = f.create(5)
  const active = f.plan(old.id, 1), separate = f.plan(other.id, 1)
  f.plan(target.id, 1)
  f.db.connection.prepare("UPDATE jobs SET state='unknown' WHERE id=?").run(active.id)
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const next = f.jobs.list({ state: 'queued' }).find(job => job.sessionId === f.repo.roles.target(target.id))!
  f.db.connection.prepare("UPDATE jobs SET payload_json=json_set(payload_json,'$.scheduler','monos') WHERE state='queued'").run()
  assert.equal(f.jobs.claim()?.id, separate.id)
  assert.equal(f.jobs.claim(), undefined)
  const memo = f.plan(target.id, 1, '提醒', 'memo.reminder')
  assert.equal(f.jobs.claim()?.id, memo.id)
  f.db.connection.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(active.id)
  assert.equal(f.jobs.claim()?.id, next.id)
})

test('retired external submissions cannot resurrect an old loop, including a delayed scheduled request', async t => {
  const f = fixture(t), old = f.create(), current = f.create(), oldPlan = f.plan(old.id, 1)
  f.plan(current.id, 1); f.repo.roles.reconcile(f.sessions, f.jobs)
  const canonical = f.repo.roles.target(current.id), retired = canonical === old.id ? current.id : old.id
  const bridge = new SelfAwakeBridge({ ...f.account(), secret: 'fixture-only' }, new SelfAwakeBridgeRepository(f.db, f.jobs), { repository: f.sessions } as never, null as never)
  t.after(() => bridge.close())
  const key = randomUUID(), result = await bridge.submit({ schema_version: 'self-awake.v2', user_id: '2', session_id: retired,
    scheduled_job_id: oldPlan.id, event_id: key, idempotency_key: key, context: {} }) as Record<string, unknown>
  assert.equal(result.retired, true); assert.equal(result.status, 'cancelled')
  assert.equal(f.jobs.list({ state: 'queued' }).length, 1)
})

test('a global fallback adopts the existing future role plan without advancing it or creating another job', t => {
  const f = fixture(t), s = f.create(), store = new SelfAwakeBridgeRepository(f.db, f.jobs)
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const planned = f.plan(s.id, Date.now() + 8 * 3600000)
  assert.equal(store.coalesce('2', 'watchdog', 'hash', s.id)?.id, planned.id)
  assert.equal(store.existing('2', 'watchdog', 'hash')?.id, planned.id)
  assert.equal(f.jobs.read(planned.id).dueAt, planned.dueAt)
  assert.equal(f.jobs.claim(), undefined)
  assert.equal(store.status('2', planned.id).status, 'pending')
  assert.throws(() => store.existing('2', 'watchdog', 'changed'), /different request/)
})

test('normal chats reuse one dedicated role context, including concurrent timer calls and restart', async t => {
  const f = fixture(t), a = f.create(4, '2', 'user_chat'), b = f.create(4, '2', 'user_chat')
  let bindings = 0
  const roles = new SelfAwakeRoleSessions({ repository: f.sessions, async endSession() {} } as never,
    { async backgroundCatalog() { bindings++; await Promise.resolve() } } as never)
  const [first, second] = await Promise.all([roles.timerTarget(a.id), roles.timerTarget(b.id)])
  assert.equal(first, second); assert.notEqual(first, a.id); assert.notEqual(first, b.id)
  assert.equal(f.sessions.read(first).purpose, 'self_awake'); assert.equal(bindings, 1)
  const restarted = new SelfAwakeRoleSessions({ repository: f.sessions } as never, null as never)
  assert.equal(await restarted.timerTarget(b.id), first)
  await roles.close(); await assert.rejects(roles.timerTarget(a.id), /关闭/)
})

test('a newer timer replaces the entire role clock and the database also rejects a second pending owner', t => {
  const f = fixture(t), a = f.create(), b = f.create()
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const target = f.repo.roles.target(a.id), first = f.plan(target), second = f.plan(target)
  assert.equal(f.jobs.read(first.id).state, 'cancelled'); assert.equal(f.jobs.read(second.id).state, 'queued')
  assert.throws(() => f.db.connection.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(first.id), /Role already|UNIQUE/)
  const retired = target === a.id ? b.id : a.id
  assert.equal(f.repo.roles.schedulerKind(retired), 'retired')
})

test('role deadlines and published activations use actual starts from every member without inventing execution facts', t => {
  const f = fixture(t), a = f.create(), b = f.create(), job = f.plan(a.id), run = f.repo.begin(job, {}, {})
  const turn = randomUUID(); f.db.connection.prepare('UPDATE self_awake_runs SET turn_id=? WHERE id=?').run(turn, run)
  f.sessions.events.append(a.id, turn, 'agent.agent_start', {})
  f.db.connection.prepare("UPDATE events SET created_at=1000 WHERE session_id=? AND kind='agent.agent_start'").run(a.id)
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const target = f.repo.roles.target(b.id)
  assert.equal(wakeDeadline(f.db, undefined, Date.now(), target), 1000 + maxWakeIntervalMs)
  const file = path.join(f.root, 'sessions', target, 'state.json')
  publishWakeActivation(f.db, file, target)
  const activation = JSON.parse(readFileSync(path.join(path.dirname(file), 'agent_activation.json'), 'utf8'))
  assert.equal(activation.session_id, target); assert.equal(activation.run_id, run)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_activations').get()?.n, 1)
})

test('merged notes are explicitly historical model context, with original times and no internal identifiers', () => {
  const notes = [{ plannedAt: '2026-10-15T12:00:00Z', reason: '核对服务' }]
  const view = selfAwakePromptContext({ merged_plans: notes, job_id: 'private', trigger: { type: 'scheduled', reason: '旧命令' } })
  assert.deepEqual(view.inheritedWakeNotes, notes)
  assert.doesNotMatch(JSON.stringify(view), /private|旧命令/)
})

test('actual v1 bridge joins the existing role clock across startup/fallback requests and isolates a changed current character', async t => {
  const f = fixture(t)
  let characterId = 4, catalogs = 0
  const core = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/api/internal/service-token/' ? { user_id: '2', token: 'fixture-only' }
      : { id: characterId, name: 'fixture', character: { id: characterId, name: 'fixture' } }))
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  t.after(async () => { core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())) })
  const base = `http://127.0.0.1:${(core.address() as { port: number }).port}`
  const owner = { coreBaseUrl: base, userId: '2', key: accountKey(base, '2') }
  const background = withAccount(owner, () => f.sessions.create('role', [{ assistantId: 4, characterId: 4 }], {}, { purpose: 'self_awake', sourceChannel: 'internal' }))
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const clock = f.plan(background.id, Date.now() + 3600000)
  const bridge = new SelfAwakeBridge({ ...owner, secret: 'fixture-only' }, new SelfAwakeBridgeRepository(f.db, f.jobs), { repository: f.sessions } as never,
    { async catalog() { catalogs++ } } as never)
  t.after(() => bridge.close())
  const request = () => ({ schema_version: 'self-awake.v1', user_id: '2', event_id: randomUUID(), idempotency_key: randomUUID(), context: { type: 'startup' } })
  const results = await Promise.all(Array.from({ length: 10 }, () => bridge.submit(request()))) as Record<string, unknown>[]
  assert.ok(results.every(result => result.job_id === clock.id && result.role_session_id === background.id))
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1)
  assert.equal(catalogs, 0); assert.equal(f.jobs.claim(), undefined)
  characterId = 5
  const other = await bridge.submit(request()) as Record<string, unknown>
  assert.notEqual(other.job_id, clock.id); assert.equal(catalogs, 1)
  assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_role_scopes').get()?.n, 2)
})

test('raw scheduling cannot revive a retired scope or forge another role clock', t => {
  const f = fixture(t), a = f.create(), b = f.create(), other = f.create(5)
  f.repo.roles.reconcile(f.sessions, f.jobs)
  const target = f.repo.roles.target(a.id), retired = target === a.id ? b.id : a.id
  assert.throws(() => f.plan(retired), /退役/)
  const clock = f.plan(target)
  assert.throws(() => f.jobs.schedule({ kind: 'self_awake', sessionId: other.id, dueAt: 1, payload: f.repo.roles.payload(target),
    key: 'forged', causationId: '', depth: 0 }), /ownership mismatch/)
  assert.equal(f.jobs.read(clock.id).state, 'queued')
})

test('closing the canonical context publishes retirement rather than silently enabling its watchdog', t => {
  const f = fixture(t), s = f.create()
  f.repo.roles.reconcile(f.sessions, f.jobs); f.plan(s.id); f.repo.timerPublication.publish()
  f.db.connection.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(s.id)
  f.repo.timerPublication.publish()
  const latest = f.requests(s.id).sort((a, b) => a.revision - b.revision).at(-1)!
  assert.equal(latest.action, 'cancel'); assert.equal(latest.scope_kind, 'retired')
})

test('cancelling background model preparation leaves no autonomous clock behind', async t => {
  const f = fixture(t), source = f.create(4, '2', 'user_chat'), signal = new AbortController()
  let closed = 0
  const targets = new SelfAwakeRoleSessions({ repository: f.sessions, async endSession() { closed++ } } as never,
    { async backgroundCatalog() { signal.abort() } } as never)
  await assert.rejects(targets.timerTarget(source.id, undefined, undefined, signal.signal), /abort/i)
  assert.equal(closed, 1); assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM self_awake_role_scopes').get()?.n, 0)
})
