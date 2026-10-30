import assert from 'node:assert/strict'
import test from 'node:test'
import { qqModelResult, privateQqCheckpoint } from '../../../src/modules/tool-results/index.ts'
import type { RuntimeCheckpoint } from '@eden/api'

test('QQ results omit host metadata while retaining business IDs, numbers, text and media verbatim', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'QUJDREVGR0g=' }
  const result = qqModelResult({ request_id: 'host-request', turnId: 'host-turn', sha256: 'host-hash',
    tid: 'business-tid', message_id: 123, file_id: 'file-123', folder_id: 0, flag: 'request-flag', next_cursor: 'cursor',
    user_id: '111111', status: 'unknown', confirmed: false, image,
    text: 'Keep host-request and business-tid exactly as written', custom: { id: 0 } }) as Record<string, unknown>
  assert.equal(result.request_id, undefined); assert.equal(result.turnId, undefined); assert.equal(result.sha256, undefined)
  assert.equal(result.tid, 'business-tid'); assert.equal(result.message_id, 123); assert.equal(result.folder_id, 0)
  assert.equal(result.flag, 'request-flag'); assert.equal(result.next_cursor, 'cursor')
  assert.equal(result.status, 'unknown'); assert.equal(result.confirmed, false)
  assert.equal(result.text, 'Keep host-request and business-tid exactly as written')
  assert.deepEqual(result.image, image); assert.deepEqual(result.custom, { id: 0 })
})

test('QQ history projects only its receipts and preserves copied prose, other tools and SDK linkage', () => {
  const checkpoint: RuntimeCheckpoint = { format: 'eden.pi-harness.v1', runtimeVersion: '0.82.0', sessionId: 'fixture',
    createdAt: 'now', entries: [
      { id: 'entry-1', parentId: null, type: 'message', message: { role: 'toolResult', toolName: 'execute_qq_action',
        toolCallId: 'sdk-call', content: [{ type: 'text', text: JSON.stringify({ request_id: 'host-request', result: { tid: 'business-tid' } }) }] } },
      { id: 'entry-2', parentId: 'entry-1', type: 'message', message: { role: 'assistant',
        content: [{ type: 'text', text: '说说ID：business-tid，编号 host-request' }] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'mcp__other', content: [{ type: 'image', data: 'QUJDREVGR0g=' }] } },
    ] }
  const before = JSON.stringify(checkpoint), filtered = privateQqCheckpoint(checkpoint)
  assert.equal(JSON.stringify(checkpoint), before)
  assert.deepEqual(filtered.entries.slice(1), checkpoint.entries.slice(1))
  assert.match(JSON.stringify(filtered.entries[0]), /business-tid|sdk-call/)
  assert.doesNotMatch(JSON.stringify(filtered.entries[0]), /host-request/)
  assert.equal((filtered.entries[0] as { id: string }).id, 'entry-1')
})
