import assert from 'node:assert/strict'
import test from 'node:test'
import type { OperationInfo, SessionEvent } from '@eden/api'
import { presentEvent } from '../../../tui/event-view.ts'
import { rememberOperation, storedTool, type ToolHistory } from '../../../tui/tool-view.ts'
import { transcriptLines } from '../../../tui/transcript-view.ts'

const event = (eventType: string, createdAt: number, payload: SessionEvent['payload']): SessionEvent =>
  ({ id: 'event', sessionId: 'session', turnId: 'turn', seq: '1', eventType, createdAt, payload })

test('tool completion replaces its running row and includes real results, errors and duration', () => {
  const tools: ToolHistory = new Map()
  const started = presentEvent(event('operation.started', 1000, { callId: 'call', name: 'terminal', args: { command: 'build' } }), false, tools)!
  const ended = presentEvent(event('operation.completed', 4500, { callId: 'call', failed: true, outcome: 'failed',
    result: { stdout: '编译开始', stderr: 'missing dependency' } }), false, tools)!
  assert.equal(ended.key, started.key)
  assert.match(ended.text, /terminal · 执行失败 · 00:03/)
  assert.match(ended.text, /missing dependency/)
  assert.match(ended.text, /build/)
  assert.equal(ended.failed, true)
  const collapsed = transcriptLines([ended], 80, false)
  assert.equal(collapsed[0]?.kind, 'error')
  assert.equal(collapsed.length, 1)
  assert.match(transcriptLines([ended], 80, false, { details: true }).map(line => line.text).join('\n'), /missing dependency/)
})

test('operation metadata recovers names and timing for completion received after reconnect', () => {
  const tools: ToolHistory = new Map()
  const operation: OperationInfo = { operationId: 'operation', sessionId: 'session', turnId: 'turn', toolCallId: 'call',
    toolName: 'read_file', capability: 'read', resource: 'file', state: 'started', request: { path: 'file' },
    result: null, error: null, createdAt: 1000, updatedAt: 1000 }
  rememberOperation(operation, tools)
  const ended = presentEvent(event('operation.completed', 3000, { callId: 'call', result: { content: [{ type: 'text', text: '文件内容' }] } }), false, tools)!
  assert.match(ended.text, /read_file · 执行完成 · 00:02/)
  assert.match(ended.text, /文件内容/)
  const stored = storedTool({ ...operation, state: 'completed', result: '历史结果', updatedAt: 5000 })
  assert.match(stored.text, /read_file · 执行完成 · 00:04/)
  assert.match(stored.text, /历史结果/)
})

test('uncertain outcomes and missing start metadata remain explicit; oversized args cannot hide the result', () => {
  const unknown = presentEvent(event('operation.completed', 2000, { callId: 'lost', outcome: 'unknown', result: '尚未确认' }))!
  assert.match(unknown.text, /结果未确认/)
  assert.equal(unknown.failed, true)
  assert.doesNotMatch(unknown.text, /00:02/)
  const tools: ToolHistory = new Map()
  presentEvent(event('operation.started', 1000, { callId: 'call', name: 'write_file', args: { content: 'x'.repeat(30_000) } }), false, tools)
  const ended = presentEvent(event('operation.completed', 2000, { callId: 'call', result: { data: 'y'.repeat(10_000), status: 'saved' } }), false, tools)!
  assert.match(ended.text, /saved/)
  assert.match(ended.text, /截断/)
  assert.match(ended.text, /10000 字符数据/)
  assert.ok(ended.text.length < 20_000)
})
