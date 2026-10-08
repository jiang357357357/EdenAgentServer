import { createHash } from 'node:crypto'
import { OperationFailure, type VoiceSynthesizeInput } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'

/** Failure budget survives host restart and stream revisions. Successful audio is still cached normally. */
export class SynthesisBudget {
  constructor(private readonly sessions: SessionRepository) {}
  private key(input: VoiceSynthesizeInput) {
    return createHash('sha256').update(JSON.stringify([input.configId, input.mode, input.text])).digest('hex')
  }
  prepare(input: VoiceSynthesizeInput) {
    if (input.intent !== 'manual' || input.sequence !== 0) return
    const db = this.sessions.database.connection
    const rows = db.prepare('SELECT SUM(attempts) AS attempts FROM voice_synthesis_failures WHERE session_id=? AND message_id=?').get(input.sessionId, input.messageId)
    if (Number(rows?.attempts ?? 0) > 0) {
      const event = this.sessions.database.transaction(() => {
        const event = this.sessions.events.insert(input.sessionId, null, 'voice.retry_requested', { messageId: input.messageId, previousFailures: Number(rows!.attempts) })
        db.prepare('DELETE FROM voice_synthesis_failures WHERE session_id=? AND message_id=?').run(input.sessionId, input.messageId)
        return event
      })
      this.sessions.events.publish(event)
    }
  }
  check(input: VoiceSynthesizeInput) {
    if (input.intent !== 'auto') return
    const db = this.sessions.database.connection
    const total = db.prepare('SELECT MAX(attempts) AS maximum,SUM(attempts) AS total FROM voice_synthesis_failures WHERE session_id=? AND message_id=?').get(input.sessionId, input.messageId)
    const chunk = db.prepare('SELECT attempts,error FROM voice_synthesis_failures WHERE session_id=? AND message_id=? AND chunk_key=?')
      .get(input.sessionId, input.messageId, this.key(input))
    if (Number(chunk?.attempts ?? 0) >= 4 || Number(total?.maximum ?? 0) >= 4 || Number(total?.total ?? 0) >= 8) {
      throw new OperationFailure(`本条消息的自动语音已暂停，可在处理原因后手动播放。${chunk?.error ? ` ${chunk.error}` : ''}`,
        { kind: 'speech_paused', retryable: false, outcome: 'failed' })
    }
  }
  failed(input: VoiceSynthesizeInput, error: unknown) {
    const terminal = error instanceof OperationFailure && !error.details.retryable
    const attempts = terminal ? 4 : 1, message = (error instanceof Error ? error.message : String(error)).slice(0, 8192)
    this.sessions.database.connection.prepare(`INSERT INTO voice_synthesis_failures VALUES(?,?,?,?,?)
      ON CONFLICT(session_id,message_id,chunk_key) DO UPDATE SET attempts=MIN(4,attempts+excluded.attempts),error=excluded.error`)
      .run(input.sessionId, input.messageId, this.key(input), attempts, message)
    this.sessions.events.append(input.sessionId, null, 'voice.synthesis.failed', { messageId: input.messageId, error: message, automaticStopped: terminal })
  }
}
