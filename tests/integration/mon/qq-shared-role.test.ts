import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { QqGroupBridge } from '../../../src/modules/qq-channel/group-bridge.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import { account, identity, sharedFixture, groupInput } from './qq-shared-support.ts'
import { mockSharedCatalog } from './qq-shared-catalog.ts'

test('role changes retain the shared conversation and explicitly invalidate its system prefix', { timeout: 30_000 }, async t => {
  let bindings = 0
  const f = await sharedFixture([{ text: '原角色回答' }, { text: '新角色接续' }], undefined, async () => { bindings++ }); t.after(f.close)
  const catalog = mockSharedCatalog(t, f.model.config)
  const a = await f.bridge.submit(groupInput(1)) as { session_id: string }; await f.idle()
  catalog.character = 3
  const b = await f.bridge.submit({ ...groupInput(2, '200002', 'core-1'), character_id: 3 }) as { session_id: string }; await f.idle()
  assert.equal(a.session_id, b.session_id)
  assert.equal(bindings, 1)
  assert.equal((withAccount(account, () => f.repository.read(a.session_id)).participants[0] as { characterId: number }).characterId, 3)
  assert.match(JSON.stringify(f.model.requests[1]), /原角色回答/)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='qq.role.changed'").get()?.n, 1)
  const estimates = f.database.connection.prepare("SELECT payload_json FROM events WHERE kind='model.request' ORDER BY seq").all()
    .map(row => JSON.parse(String(row.payload_json)).contextEstimate)
  assert.equal(estimates[1].promptCacheEpoch, estimates[0].promptCacheEpoch + 1)
  const legacy = new QqGroupBridge(identity, f.database, f.sessions, {} as MonBindingService, new AbortController().signal)
  assert.throws(() => legacy.submit({ ...groupInput(3), schema_version: 'qq-group-turn.v3', context: undefined }), /shared history/)
})

test('queued group inputs prevent a role change from changing their frozen author', { timeout: 30_000 }, async t => {
  const f = await sharedFixture([{ wait: true }]); t.after(f.close)
  await f.bridge.submit(groupInput(1))
  for (let index = 0; f.model.requests.length === 0 && index < 400; index++) await delay(10)
  await assert.rejects(f.bridge.submit({ ...groupInput(2, '200002', 'core-1'), character_id: 3 }), /queued group inputs/)
  await f.bridge.cancel({ user_id: '7', bot_qq: '100001', group_qq: '300001', contact_qq: '200001', message_id: 'native-1' })
  await f.idle()
  assert.equal(f.model.requests.length, 1)
})
