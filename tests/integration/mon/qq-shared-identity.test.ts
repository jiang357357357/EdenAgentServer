import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { qqSharedContextSchema } from '@eden/api'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { qqGroupOrigin } from '../../../src/modules/qq-channel/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { SessionService } from '../../../src/modules/sessions/index.ts'
import { QqSharedRepository } from '../../../src/modules/qq-channel/shared-repository.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { account, identity, sharedFixture, groupInput } from './qq-shared-support.ts'

test('cancelling A leaves B queued, and a stale A tool cannot borrow B identity', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ wait: true }, { text: 'B 继续' }]); t.after(f.close)
  const a = await f.bridge.submit(groupInput(1)) as { input_id: string; turn_id: string }
  for (let index = 0; !f.model.requests.length && index < 500; index++) await delay(10)
  const b = await f.bridge.submit(groupInput(2, '200002', 'core-1')) as { input_id: string; turn_id: string }
  const client = new NapcatClient(f.repository, identity)
  assert.equal(withAccount(account, () => client.target(f.session.id, undefined, a.turn_id)).qqContext?.contact_qq, '200001')
  assert.throws(() => qqGroupOrigin(f.database, f.session.id), /executing turn/)
  assert.deepEqual(await f.bridge.cancel({ user_id: '7', bot_qq: '100001', group_qq: '300001', contact_qq: '200002', message_id: 'native-1' }), { cancelled: false })
  await f.bridge.cancel({ user_id: '7', bot_qq: '100001', group_qq: '300001', contact_qq: '200001', message_id: 'native-1' })
  await f.idle()
  assert.equal(f.database.connection.prepare('SELECT state FROM inputs WHERE id=?').get(a.input_id)?.state, 'cancelled')
  assert.equal(f.database.connection.prepare('SELECT state FROM inputs WHERE id=?').get(b.input_id)?.state, 'completed')
  assert.throws(() => withAccount(account, () => client.target(f.session.id, undefined, a.turn_id)), /no longer active/)
  assert.deepEqual(f.database.connection.prepare('SELECT operator_qq FROM qq_group_inputs ORDER BY source_seq').all().map(row => row.operator_qq), ['200001', '200002'])
  assert.equal(f.model.requests.length, 2)
})

test('restart holds the interrupted operation but resumes other shared-group queued inputs', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: '初始化' }, { text: '恢复 B' }]); t.after(f.close)
  const first = await f.bridge.submit(groupInput(1)) as { input_id: string }; await f.idle()
  const metadata = JSON.parse(String(f.database.connection.prepare('SELECT metadata_json FROM inputs WHERE id=?').get(first.input_id)?.metadata_json))
  await f.sessions.close()
  const inputs = new InputRepository(f.database, f.repository.events), shared = new QqSharedRepository(f.database)
  for (const [sequence, operator] of [[2, '200001'], [3, '200002']] as const) {
    const context = groupInput(sequence, operator).context
    const accepted = inputs.enqueue(f.session.id, `question-${sequence}`, `restart-${sequence}`, { ...metadata, channelContext: context }, 'prompt', undefined,
      input => shared.admit(f.session.id, input, qqSharedContextSchema.parse(context)))
    if (sequence === 2) { assert.ok(accepted.inputId); inputs.claim(f.session.id) }
  }
  const recovered = new SessionService(f.repository, f.model.config)
  t.after(() => recovered.close())
  withAccount(account, () => recovered.resumePending())
  await recovered.waitForIdle(f.session.id)
  const states = f.database.connection.prepare("SELECT state FROM inputs WHERE idempotency_key LIKE 'restart-%' ORDER BY created_at,rowid").all().map(row => row.state)
  assert.deepEqual(states, ['interrupted', 'completed'])
  assert.equal(f.model.requests.length, 2)
})
