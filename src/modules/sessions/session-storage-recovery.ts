import type { SessionRepository } from './session-repository.ts'
import type { InputRepository } from './input/input-repository.ts'
import type { SignalRepository } from './input/signal-repository.ts'
import { sessionStorage } from './session-storage.ts'
import { logDiagnostic } from '../logging/index.ts'
import { assertRuntimeCheckpoint } from '@eden/runtime-pi'

/** A new explicit submission can recover only after validating the checkpoint and committing a new durable event. */
export function recoverSessionStorage(repository: SessionRepository, inputs: InputRepository, signals: SignalRepository,
  sessionId: string, previousFailure: string, validateExtension?: () => void): void {
  const session = repository.read(sessionId)
  if (session.status !== 'active') throw new Error('Session is closed')
  const checkpoint = repository.checkpoint(sessionId)
  if (checkpoint) assertRuntimeCheckpoint(checkpoint, sessionId)
  validateExtension?.()
  const reason = `上轮执行因存储故障中断：${previousFailure}`
  for (const input of inputs.running(sessionId)) { signals.interrupt(input.turnId); inputs.finish(input, reason) }
  inputs.holdQueued(sessionId, reason)
  const event = sessionStorage('会话存储恢复检查失败', () => repository.database.transaction(() => {
    if (checkpoint) repository.database.connection.prepare(`INSERT INTO runtime_checkpoints VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,updated_at=excluded.updated_at`)
      .run(sessionId, JSON.stringify(checkpoint), Date.now())
    return repository.events.insert(sessionId, null, 'session.storage.recovered', { previousFailure })
  }))
  repository.events.publish(event)
  logDiagnostic({ event: 'session.storage.recovered', message: '会话存储已恢复，接受新的输入。',
    origin: repository.origin, sessionId }, 'info')
}
