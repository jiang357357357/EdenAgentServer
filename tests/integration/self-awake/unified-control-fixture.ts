import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/index.ts'
import { OsScheduler, readState } from '../../../src/modules/os/index.ts'
import type { OsTarget, State } from '../../../src/modules/os/index.ts'
import { osFixture } from '../../helpers/os-config.ts'

export async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 6000
  while (!condition() && Date.now() < deadline) await delay(20)
  assert.ok(condition(), message)
}

/** Real SQLite control, persisted timer publication, real interval clock; no model or external message. */
export function unifiedControlFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-unified-awake-')), config = osFixture(root)
  config.identity = { userId: '2', coreBaseUrl: 'http://127.0.0.1:1', secret: 'isolated-fixture' }
  config.selfAwakeEnabled = false; config.startupWakeEnabled = false; config.startupDelaySeconds = 0
  const account = { userId: '2', coreBaseUrl: config.identity.coreBaseUrl, key: accountKey(config.identity.coreBaseUrl, '2') }
  const filename = path.join(root, 'account.sqlite'), stateFile = path.join(config.wakeDir, 'state.json')
  const calls: State[] = []
  let memoPolls = 0, ready = true, memoFailure = false
  let database: EdenDatabase, awake: SelfAwakeRepository, jobs: JobRepository, sessions: SessionRepository
  const open = () => {
    database = new EdenDatabase(filename, 'mon')
    database.connection.prepare("INSERT OR REPLACE INTO realm_meta VALUES('account_key',?)").run(account.key)
    awake = new SelfAwakeRepository(database, stateFile, true); awake.control.initialize(config.selfAwakeEnabled)
    jobs = new JobRepository(database, true, () => awake.control.read().enabled)
    sessions = new SessionRepository(database, 'mon')
  }
  open()
  const session = withAccount(account, () => sessions.create('isolated self-awake role', [{ assistantId: 1 }]))
  const target: OsTarget = {
    ready: () => ready, control: async () => awake.control.read(),
    async run(input) { awake.control.assertEnabled(); calls.push(input as State); return { accepted: true, job_id: randomUUID() } },
    async status() { return { status: 'pending' } },
    async admitReminder() { return { memoId: 1 } }, async reminderDelivery() { return null },
  }
  const core = { async request() { memoPolls++; if (memoFailure) throw new Error('isolated memo endpoint unavailable'); return { memos: [], next_wake_at: null } } }
  let scheduler = new OsScheduler(config, target, core)
  t.after(async () => {
    await scheduler.close(); database.close()
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })
  const plan = (dueAt = Date.now() - 1000) => jobs.schedule({ kind: 'self_awake', sessionId: session.id,
    dueAt, payload: { prompt: 'fixture scheduled turn' }, key: randomUUID(), causationId: '', depth: 0 })
  return { config, root, stateFile, account, calls, plan,
    get database() { return database }, get awake() { return awake }, get jobs() { return jobs },
    get memoPolls() { return memoPolls }, get scheduler() { return scheduler },
    setReady(value: boolean) { ready = value },
    failMemos() { memoFailure = true },
    lease: () => readState(path.join(config.wakeDir, 'session-protocol.json')),
    enabled(value: boolean) { return awake.updateControl(value, awake.control.read().updatedAt) },
    async restart() { await scheduler.close(); database.close(); open(); scheduler = new OsScheduler(config, target, core); scheduler.start() },
  }
}
