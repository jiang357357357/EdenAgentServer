import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@eden/api'
import { ReplyClock } from '../../../tui/reply-clock.ts'

const event = (seq: number, eventType: string, createdAt: number, payload: SessionEvent['payload'] = {}, turnId = 'turn-a'): SessionEvent =>
  ({ id: `event-${seq}`, sessionId: 'session-a', turnId, seq: String(seq), eventType, payload, createdAt })

test('server snapshots and a monotonic clock measure only the current turn', () => {
  let time = 100
  const clock = new ReplyClock(() => time)
  clock.connection(true)
  clock.restore({ turn: { turnId: 'turn-a', startedAt: 10_000, outcome: 'running' }, observedAt: 12_000, seq: '4' })
  time += 1500
  assert.equal(clock.read().elapsedMs, 3500)
  clock.connection(false); time += 8000
  assert.equal(clock.read().elapsedMs, 3500)
  clock.connection(true)
  clock.restore({ turn: { turnId: 'turn-a', startedAt: 10_000, outcome: 'completed', finishedAt: 15_000 }, observedAt: 20_000, seq: '8' })
  time += 1000
  assert.deepEqual(clock.read(), { elapsedMs: 5000, phase: '本轮完成' })
  clock.observe(event(9, 'turn.started', 30_000, {}, 'turn-b'))
  assert.deepEqual(clock.read(), { elapsedMs: 0, phase: '正在处理' })
})

test('phase tracks concurrent tools and model requests; replay cannot roll the clock back', () => {
  const clock = new ReplyClock(() => 0)
  clock.connection(true)
  clock.observe(event(1, 'turn.started', 1000))
  clock.observe(event(2, 'model.request', 1100, { requestId: 'model-a' }))
  assert.equal(clock.read().phase, '等待模型')
  clock.observe(event(3, 'operation.started', 1200, { callId: 'tool-a' }))
  clock.observe(event(4, 'operation.started', 1300, { callId: 'tool-b' }))
  clock.observe(event(5, 'operation.completed', 1400, { callId: 'tool-a' }))
  assert.equal(clock.read().phase, '执行工具')
  clock.observe(event(6, 'operation.completed', 1500, { callId: 'tool-b' }))
  assert.equal(clock.read().phase, '等待模型')
  clock.observe(event(7, 'model.response', 1600, { requestId: 'model-a' }))
  clock.observe(event(8, 'turn.failed', 2000))
  clock.observe(event(1, 'turn.started', 1000))
  clock.restore({ turn: null, seq: '2', observedAt: 1100 })
  assert.deepEqual(clock.read(), { elapsedMs: 1000, phase: '本轮失败' })
})

test('reconnecting restores in-flight phases and interrupted turns stop advancing', () => {
  let time = 0
  const clock = new ReplyClock(() => time)
  clock.connection(true)
  clock.restore({ turn: { turnId: 'turn-a', startedAt: 1000, outcome: 'running' }, seq: '4', observedAt: 4000,
    breakdown: { tools: { elapsedMs: 1000, activeSince: 3000, activeIds: ['tool-a'] },
      thinking: { elapsedMs: 500, activeIds: [] }, turnElapsedMs: 3000 } })
  assert.equal(clock.read().phase, '执行工具')
  clock.observe(event(5, 'input.interrupted', 5000)); time += 10_000
  assert.deepEqual(clock.read(), { elapsedMs: 4000, phase: '本轮中断' })
  clock.reset()
  assert.deepEqual(clock.read(), { phase: '就绪' })
})
