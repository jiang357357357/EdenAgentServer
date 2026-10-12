import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { monServiceConfig } from '../../../src/bootstrap/mon-service-config.ts'
import { workspaceSchedulerStateFile } from '../../../src/bootstrap/mon-scheduler-path.ts'
import { EdenDatabase } from '@eden/store'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { selfAwakeTools } from '../../../src/modules/self-awake/tools.ts'

function fixture(t: test.TestContext, portable = false, ini?: string) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'eden-scheduler-binding-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, '当前安装 中文'), module = portable ? 'runtime/os' : 'BaseOs'
  const agent = path.join(root, portable ? 'runtime/agent' : 'Agent')
  mkdirSync(agent, { recursive: true }); mkdirSync(path.join(root, module), { recursive: true })
  mkdirSync(path.join(root, 'Config', 'ENV'), { recursive: true })
  writeFileSync(path.join(root, '.monconfig'), '')
  writeFileSync(path.join(root, '.monworkspace'), JSON.stringify({ modules: [{ id: 'baseos', root: module, config: '.monconfig' }] }))
  writeFileSync(path.join(root, module, '.monconfig'), ini ?? `[self_awake]\nDATA_DIR=${portable ? '../../Data/Os/SelfAwake' : 'Data/SelfAwake'}\n`)
  const auth = path.join(root, 'Config', 'ENV', 'service-auth.env')
  writeFileSync(auth, 'MON_SERVICE_SHARED_SECRET=fixture-only-secret\nMON_SERVICE_USER_ID=2\n')
  return { temporary, root, agent, module, auth, env: { EDEN_AGENT_RUNTIME_ORIGIN: 'mon' } }
}

for (const portable of [false, true]) {
  test(`${portable ? 'portable' : 'source'} startup derives identity and future MonOs path without creating state`, t => {
    const f = fixture(t, portable), config = loadConfig(f.env, f.agent)
    const state = path.join(f.root, portable ? 'Data/Os/SelfAwake/state.json' : 'BaseOs/Data/SelfAwake/state.json')
    assert.equal(config.monIdentity?.userId, '2'); assert.equal(config.selfAwakeScheduleFile, state)
    assert.equal(loadConfig({ ...f.env, EDEN_AGENT_RUNTIME_ORIGIN: 'local' }, f.agent).selfAwakeScheduleFile, undefined)
    assert.throws(() => readFileSync(state), /ENOENT/, 'Only MonOs may initialize its state')
  })
}

test('module path, INI casing/comments, default directory and MonOs environment override agree', t => {
  const f = fixture(t, false, '[SELF_AWAKE] ; comments\ndata_dir = 自醒 # comment\nOTHER=https://example.test/a#b\n')
  assert.equal(workspaceSchedulerStateFile(f.root, {}), path.join(f.root, 'BaseOs/自醒/state.json'))
  assert.equal(workspaceSchedulerStateFile(f.root, { MONOS_DATA_DIR: '../指定目录' }), path.join(f.root, '指定目录/state.json'))
  writeFileSync(path.join(f.root, f.module, '.monconfig'), '')
  assert.equal(workspaceSchedulerStateFile(f.root, {}), path.join(f.root, 'BaseOs/Data/SelfAwake/state.json'))
  assert.throws(() => workspaceSchedulerStateFile(f.root, { MONOS_DATA_DIR: '' }), /不得为空/)
})

test('relocating a portable installation recalculates its scheduler and ignores an old realm binding with explicit identity', t => {
  const f = fixture(t, true), realm = path.join(f.agent, 'Data/realms/mon')
  mkdirSync(realm, { recursive: true })
  writeFileSync(path.join(realm, 'mon-service.json'), JSON.stringify({ authFile: f.auth,
    coreBaseUrl: 'http://127.0.0.1:49999', scheduleStateFile: path.join(f.root, 'old/state.json') }))
  const moved = path.join(f.temporary, '移动后的便携包'); renameSync(f.root, moved)
  const env = { ...f.env, MON_SERVICE_SHARED_SECRET: 'fixture-only-secret', MON_SERVICE_USER_ID: '2' }
  const config = loadConfig(env, path.join(moved, 'runtime/agent'))
  assert.equal(config.selfAwakeScheduleFile, path.join(moved, 'Data/Os/SelfAwake/state.json'))
  assert.equal(config.monIdentity?.coreBaseUrl, 'http://127.0.0.1:40011')
})

test('legacy explicit references retain priority and another deployment cannot borrow the workspace scheduler', t => {
  const f = fixture(t), realm = path.join(f.agent, 'Data/realms/mon'), explicit = path.join(f.root, 'explicit.json')
  mkdirSync(realm, { recursive: true }); writeFileSync(explicit, '{}')
  const env = { MON_SERVICE_SHARED_SECRET: 'explicit', MON_SERVICE_USER_ID: '3', MONOS_SELF_AWAKE_STATE_PATH: explicit }
  assert.equal(monServiceConfig('mon', realm, env, f.root).scheduleStateFile, explicit)
  const configFile = path.join(realm, 'mon-service.json'), unrelated = path.join(realm, 'unrelated.env')
  writeFileSync(unrelated, 'MON_SERVICE_SHARED_SECRET=other\nMON_SERVICE_USER_ID=3\n')
  writeFileSync(configFile, JSON.stringify({ authFile: unrelated, coreBaseUrl: 'http://127.0.0.1:40111' }))
  assert.equal(monServiceConfig('mon', realm, {}, f.root).scheduleStateFile, undefined)
  writeFileSync(configFile, JSON.stringify({ authFile: f.auth, coreBaseUrl: 'http://127.0.0.1:40011' }))
  assert.equal(monServiceConfig('mon', realm, {}, f.root).scheduleStateFile, path.join(f.root, 'BaseOs/Data/SelfAwake/state.json'))
})

test('invalid module manifests and MonOs configuration are explicit errors', t => {
  const f = fixture(t), manifest = path.join(f.root, '.monworkspace')
  writeFileSync(manifest, '{')
  assert.throws(() => loadConfig(f.env, f.agent), /模块清单/)
  writeFileSync(manifest, JSON.stringify({ modules: [{ id: 'baseos', root: f.module }, { id: 'baseos', root: f.module }] }))
  assert.throws(() => loadConfig(f.env, f.agent), /重复的 baseos/)
  writeFileSync(manifest, JSON.stringify({ modules: [{ id: 'baseos', root: f.module }] }))
  writeFileSync(path.join(f.root, f.module, '.monconfig'), '[self_awake]\nDATA_DIR=\n')
  assert.throws(() => loadConfig(f.env, f.agent), /不得为空/)
})

test('derived binding publishes a real timer request while missing or unreadable bindings remain visible', async t => {
  const f = fixture(t, true), config = loadConfig(f.env, f.agent), stateFile = config.selfAwakeScheduleFile!
  const database = new EdenDatabase(':memory:', 'mon'); t.after(() => database.close())
  const session = new SessionRepository(database, 'mon').create('isolated fixture')
  const jobs = new JobRepository(database, true), repository = new SelfAwakeRepository(database, stateFile, true)
  assert.equal(repository.list({}).schedule?.status, 'unavailable')
  mkdirSync(path.dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ enabled: true, next_wake_at: null }))
  writeFileSync(path.join(path.dirname(stateFile), 'session-protocol.json'), JSON.stringify({ protocolVersion: 2, sessionScopes: true, expiresAt: Date.now() + 30000 }))
  const permissions = { async request() {} }
  const timer = selfAwakeTools(repository, jobs, permissions as never, null as never, session.id, 'fixture-turn').find(tool => tool.name === 'set_self_awake_timer')!
  const result = await timer.execute({ afterMinutes: 10, reason: 'fixture timer' }, { callId: 'fixture-call', signal: new AbortController().signal })
  assert.equal((result as Record<string, unknown>).delivery, 'persisted_and_published')
  const job = jobs.list({ state: 'queued' })[0]!, revision = database.connection.prepare('SELECT revision FROM self_awake_session_schedules WHERE session_id=?').get(session.id)!.revision
  const request = JSON.parse(readFileSync(path.join(path.dirname(stateFile), 'sessions', session.id, 'schedule_requests', `${revision}.json`), 'utf8'))
  assert.equal(request.job_id, job.id); assert.equal(Date.parse(request.next_wake_at), job.dueAt)
  const missing = new SelfAwakeRepository(database, undefined, true)
  assert.equal(missing.context(session.id, 'fixture-turn').wakeSchedule?.status, 'unavailable')
  const rejected = selfAwakeTools(missing, jobs, permissions as never, null as never, session.id, 'fixture-turn')[1]!
  await assert.rejects(rejected.execute({ afterMinutes: 20, reason: 'rejected' }, { callId: 'bad', signal: new AbortController().signal }), /自醒调度未配置/)
  assert.equal(jobs.list({ state: 'queued' }).length, 1)
  writeFileSync(stateFile, '{')
  assert.equal(repository.list({}).schedule?.status, 'unavailable')
})
