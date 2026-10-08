import assert from 'node:assert/strict'
import test from 'node:test'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { faultFixture } from './fault-recovery-fixture.ts'

test('real request persistence failure stays blocked while SQLite is read-only and recovers after repair without restarting', async t => {
  const f = await faultFixture(t), session = f.repository.create('Request storage fault')
  f.database.connection.exec("CREATE TRIGGER reject_request BEFORE INSERT ON events WHEN NEW.kind='model.request' BEGIN SELECT RAISE(ABORT,'fixture request disk failure'); END")
  const failed = f.sessions.start(session.id, 'Persist this request'), held = f.sessions.start(session.id, 'Keep this queued')
  await f.sessions.waitForIdle(session.id)
  assert.equal(f.sessions.faultCount(), 1); assert.equal(f.model.requests.length, 0)
  assert.equal(f.input(failed.inputId).state, 'interrupted'); assert.equal(f.input(held.inputId).state, 'held')
  f.database.connection.exec('DROP TRIGGER reject_request; PRAGMA query_only=ON')
  assert.throws(() => f.sessions.start(session.id, 'Still read-only'), /会话存储尚未恢复.*readonly/)
  assert.equal(f.sessions.faultCount(), 1)
  assert.throws(() => f.sessions.submitJob(session.id, 'No background recovery', 'job', 'self_awake', () => {}), /会话存储尚未恢复/)
  assert.equal(f.events(session.id).filter(event => event.kind === 'session.storage.recovered').length, 0)
  f.database.connection.exec('PRAGMA query_only=OFF')
  const recovered = f.sessions.start(session.id, 'Storage is repaired')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(recovered.inputId)
  assert.equal(f.sessions.faultCount(), 0); assert.equal(f.model.requests.length, 1)
  assert.equal(f.input(held.inputId).state, 'held')
  assert.equal(f.events(session.id).filter(event => event.kind === 'session.storage.recovered').length, 1)
})

test('a completed side effect with an uncommitted result becomes unknown and is never replayed during recovery', async t => {
  const f = await faultFixture(t, [{ tool: 'write_once', input: {} }, { text: 'Fresh user request completed' }])
  const session = f.repository.create('Uncertain side effect')
  let effects = 0
  f.setTools([{ name: 'write_once', description: 'fixture', revision: '1', parameters: { type: 'object', properties: {} },
    async execute() { effects++; f.database.connection.exec('PRAGMA query_only=ON'); return { written: true } } }])
  const failed = f.sessions.start(session.id, 'Execute once'), held = f.sessions.start(session.id, 'Do not replay this')
  await f.sessions.waitForIdle(session.id)
  assert.equal(effects, 1); assert.equal(f.sessions.faultCount(), 1)
  assert.equal(f.input(failed.inputId).state, 'running')
  assert.throws(() => f.sessions.start(session.id, 'Blocked attempt'), /会话存储尚未恢复.*readonly/)
  f.database.connection.exec('PRAGMA query_only=OFF')
  const recovered = f.sessions.start(session.id, 'A new explicit request')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(recovered.inputId)
  assert.equal(effects, 1); assert.equal(f.model.requests.length, 2)
  assert.equal(f.input(failed.inputId).state, 'interrupted'); assert.equal(f.input(held.inputId).state, 'held')
  assert.equal(f.database.connection.prepare('SELECT state FROM tool_operations WHERE turn_id=?').get(failed.turnId)!.state, 'unknown')
  assert.ok(f.events(session.id).some(event => event.kind === 'operation.completed' && JSON.stringify(event.payload).includes('unknown')))
})

for (const damage of ['envelope', 'tree'] as const) test(`damaged checkpoint ${damage} cannot be discarded or overwritten; actual repair permits a new turn`, async t => {
  const f = await faultFixture(t, [{ text: 'Before damage' }, { text: 'After repair' }]), session = f.repository.create('Checkpoint fault')
  f.sessions.start(session.id, 'Create history'); await f.sessions.waitForIdle(session.id)
  const previous = String(f.database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(session.id)!.checkpoint_json)
  const damaged = damage === 'envelope' ? '{"format":"invalid"}' : JSON.stringify({ ...JSON.parse(previous), entries: [{ type: 'message' }] })
  f.database.connection.prepare('UPDATE runtime_checkpoints SET checkpoint_json=? WHERE session_id=?').run(damaged, session.id)
  f.sessions.start(session.id, 'Read damaged history'); await f.sessions.waitForIdle(session.id)
  assert.equal(f.sessions.faultCount(), 1); assert.equal(f.model.requests.length, 1)
  assert.throws(() => f.sessions.start(session.id, 'Do not erase history'), /会话存储尚未恢复/)
  assert.equal(f.database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(session.id)!.checkpoint_json, damaged)
  f.database.connection.prepare('UPDATE runtime_checkpoints SET checkpoint_json=? WHERE session_id=?').run(previous, session.id)
  const recovered = f.sessions.start(session.id, 'Continue after actual repair')
  await f.sessions.waitForIdle(session.id); f.assertCompleted(recovered.inputId)
  assert.equal(f.sessions.faultCount(), 0); assert.equal(f.model.requests.length, 2)
  assert.match(JSON.stringify(f.model.requests.at(-1)), /Before damage/)
})

test('a faulted account session cannot be recovered or inspected by another account and healthy peer sessions continue', async t => {
  const f = await faultFixture(t, [{ text: 'Healthy peer' }, { text: 'Repaired account' }], 'mon')
  const owner = { userId: 'owner', coreBaseUrl: 'http://fixture.invalid', key: accountKey('http://fixture.invalid', 'owner') }
  const other = { ...owner, userId: 'other', key: accountKey(owner.coreBaseUrl, 'other') }
  const session = withAccount(owner, () => f.repository.create('Faulted')), peer = withAccount(other, () => f.repository.create('Healthy'))
  f.database.connection.exec(`CREATE TRIGGER reject_owned_request BEFORE INSERT ON events WHEN NEW.kind='model.request' AND NEW.session_id='${session.id}' BEGIN SELECT RAISE(ABORT,'private fault cause'); END`)
  withAccount(owner, () => f.sessions.start(session.id, 'Fail')); await f.sessions.waitForIdle(session.id)
  assert.equal(f.sessions.faultCount(), 1)
  assert.throws(() => withAccount(other, () => f.sessions.start(session.id, 'Foreign recovery')), error => {
    assert.match(String(error), /不属于当前账号/); assert.doesNotMatch(String(error), /private fault cause/); return true
  })
  const healthy = withAccount(other, () => f.sessions.start(peer.id, 'Continue peer'))
  await f.sessions.waitForIdle(peer.id); f.assertCompleted(healthy.inputId)
  assert.equal(f.sessions.faultCount(), 1)
  f.database.connection.exec('DROP TRIGGER reject_owned_request')
  const recovered = withAccount(owner, () => f.sessions.start(session.id, 'Owned recovery'))
  await f.sessions.waitForIdle(session.id); f.assertCompleted(recovered.inputId)
  assert.equal(f.sessions.faultCount(), 0)
})
