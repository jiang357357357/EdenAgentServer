import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CoreMemoScheduler } from '../../../src/modules/os/memo-scheduler.ts'
import { osFixture } from '../../helpers/os-config.ts'
import type { OsCoreClient } from '../../../src/modules/os/core-client.ts'
import type { ReminderInput, ReminderTarget } from '../../../src/modules/os/index.ts'
import { readState } from '../../../src/modules/os/state-store.ts'

test('Core reminders use the independent memo queue; acknowledgment follows durable notification and restart does not re-admit', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-core-reminder-')), config = osFixture(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  config.identity = { userId: '2', coreBaseUrl: 'http://127.0.0.1:1', secret: 'isolated' }
  config.memoReconcileSeconds = 1
  const memo = { id: 9, user: 2, title: '独立到期提醒', content: '不与自醒合并', priority: 'normal',
    trigger_at: new Date(1000).toISOString(), updated_at: new Date(2000).toISOString() }
  let delivered: number | null = null, admits = 0, acks = 0
  const inputs: ReminderInput[] = []
  const target: ReminderTarget = {
    async admitReminder(input) { inputs.push(input); admits++; return { memoId: 7 } },
    async reminderDelivery(id) { assert.equal(id, 7); return delivered },
  }
  const core: Pick<OsCoreClient, 'request'> = { async request(method: string, pathname: string, payload?: unknown) {
    if (pathname.endsWith('/dispatch-due/')) return { memos: [memo], next_wake_at: null }
    assert.equal(pathname, '/api/memos/9/ack-dispatch/'); assert.notEqual(delivered, null)
    assert.deepEqual(payload, { expected_trigger_at: memo.trigger_at, expected_updated_at: memo.updated_at, delivered_at: new Date(delivered!).toISOString() })
    acks++; return { acknowledged: true }
  } }
  await new CoreMemoScheduler(config, core, target).tick(5000)
  assert.equal(admits, 1); assert.equal(acks, 0)
  await new CoreMemoScheduler(config, core, target).tick(7000)
  assert.equal(admits, 1); assert.equal(acks, 0)
  delivered = 8000
  await new CoreMemoScheduler(config, core, target).tick(9000)
  assert.equal(admits, 1); assert.equal(acks, 1)
  assert.equal(inputs[0]!.sourceId, '9')
  assert.equal(readState(path.join(config.memoDir, 'state.json')).in_flight['9'].delivered_at, new Date(8000).toISOString())
})
