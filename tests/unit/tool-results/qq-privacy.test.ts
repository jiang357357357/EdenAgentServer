import assert from 'node:assert/strict'
import test from 'node:test'
import { qqModelResult, privateQqCheckpoint } from '../../../src/modules/tool-results/index.ts'
import type { RuntimeCheckpoint } from '@eden/api'

test('QQ receipt projection hides technical IDs and preserves business targets, text, status and emoji', () => {
  const result = qqModelResult({ request_id: 'private-request', requestId: 'private-other-request', tid: 'private-tid',
    message_id: 123, user_id: '111111', group_id: '222222', bot_id: '42', status: 'unknown', confirmed: false,
    file: { fileId: 'private-file', sha256: 'private-hash' }, parameters: { tid: 'private-nested-tid' },
    message_ids: ['private-message-list'], resource_ids: { file: ['private-resource-file'] },
    rounds: [{ messages: [{ id: 5, content: '正文' }] }],
    message: [{ type: 'face', data: { id: 123 } }, { type: 'reply', data: { id: 'private-message' } }] }) as Record<string, unknown>
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /private-/)
  assert.equal(result.status, 'unknown'); assert.equal(result.confirmed, false)
  assert.equal(result.user_id, '111111'); assert.equal(result.group_id, '222222'); assert.equal(result.bot_id, '42')
  assert.match(serialized, /正文/); assert.match(serialized, /"id":123/)
})

test('restored QQ history masks legacy receipt IDs and copied assistant prose without changing tree linkage or source', () => {
  const checkpoint: RuntimeCheckpoint = { format: 'eden.pi-harness.v1', runtimeVersion: '0.82.0', sessionId: 'fixture',
    createdAt: 'now', entries: [
      { id: 'entry-1', parentId: null, type: 'message', message: { role: 'toolResult', toolName: 'execute_qq_action',
        toolCallId: 'sdk-call', content: [{ type: 'text', text: JSON.stringify({ request_id: 'private-request', result: { tid: 'native-tid-123' } }) }] } },
      { id: 'entry-2', parentId: 'entry-1', type: 'message', message: { role: 'assistant',
        content: [{ type: 'text', text: '说说 ID：native-tid-123' }, { type: 'thinking', thinking: '凭据 private-request' }] } },
      { id: 'entry-3', parentId: 'entry-2', type: 'compaction', summary: '已发布 native-tid-123' },
    ] }
  const filtered = privateQqCheckpoint(checkpoint)
  assert.doesNotMatch(JSON.stringify(filtered), /native-tid-123|private-request/)
  assert.match(JSON.stringify(checkpoint), /native-tid-123/)
  const second = filtered.entries[1] as { id: string; parentId: string }
  assert.equal(second.id, 'entry-2'); assert.equal(second.parentId, 'entry-1')
})
