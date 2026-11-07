import assert from 'node:assert/strict'
import test from 'node:test'
import { memoCreateSchema } from '@eden/api'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { MemoRepository, MemoNotifications, MemoDeliveryRepository } from '../../../src/modules/memos/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { qqGroupOrigin, sharedGroupRuntime } from '../../../src/modules/qq-channel/index.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { account, sharedFixture, groupInput } from './qq-shared-support.ts'

test('a group reminder retains its creator after another member speaks', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ text: 'A 创建提醒' }, { text: 'B 提问' }]); t.after(f.close)
  const a = await f.bridge.submit(groupInput(1)) as { turn_id: string }; await f.idle()
  const jobs = new JobRepository(f.database), memos = new MemoRepository(f.database, jobs)
  const deliveries = new MemoDeliveryRepository(f.database, memos, new MemoNotifications(f.database), jobs)
  const memo = withAccount(account, () => memos.create(memoCreateSchema.parse({ title: '喝水', kind: 'reminder',
    remindAt: Date.now() - 1000, relatedSessionId: f.session.id }), 'creator-memo', a.turn_id))
  await f.bridge.submit(groupInput(2, '200002', 'core-1')); await f.idle()
  const job = jobs.claim()!; assert.ok(job)
  deliveries.enqueue(job, memo)
  const delivery = deliveries.claim()!; assert.ok(delivery)
  const inputs = new InputRepository(f.database, f.repository.events)
  const accepted = withAccount(account, () => inputs.enqueue(f.session.id, '提醒老师喝水', 'memo-input',
    { job: { id: job.id, kind: job.kind } }, 'prompt', undefined, value => deliveries.attachInput(delivery, value.inputId)))
  const running = inputs.claim(f.session.id)!; assert.ok(running)
  assert.equal(qqGroupOrigin(f.database, f.session.id, accepted.turnId)?.contact_qq, '200001')
  const rendered = sharedGroupRuntime(f.database, running, '')
  assert.match(rendered!.text, /A（超级管理员）（200001）/)
  assert.doesNotMatch(rendered!.text, /B（|200002/)
  assert.throws(() => qqGroupOrigin(f.database, f.session.id, a.turn_id), /no longer active/)
})
