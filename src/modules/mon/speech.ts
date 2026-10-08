import { z } from 'zod'
import { MonHttpError } from '@eden/integrations'
import type { MonClient } from '@eden/integrations'
import { OperationFailure, toJson } from '@eden/api'
import type { VoiceSynthesizeInput } from '@eden/api'
import type { MonOperationRepository } from './operation-repository.ts'
const resultSchema = z.object({ success: z.boolean(), audio_url: z.string().max(4096).nullish(), duration_ms: z.number().int().nonnegative().nullable().optional() })
function coreSpeechFailure(raw: import('@eden/api').JsonValue) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.error_message === 'string'
    ? raw.error_message.slice(0, 4096) : 'Core reported speech synthesis failure'
}
export async function synthesizeMonSpeech(client: MonClient, operations: MonOperationRepository, input: VoiceSynthesizeInput, signal: AbortSignal) {
  const endpoint = '/api/tts/configs/synthesize/'
  const body = toJson({ external_session_id: input.sessionId, external_message_id: input.messageId, segment_group_id: input.segmentGroupId,
    group_index: input.groupIndex, sequence: input.sequence, text: input.text, config_id: input.configId, mode: input.mode })
  signal.throwIfAborted()
  const id = operations.begin(input.sessionId, endpoint, toJson({ messageId: input.messageId, segmentGroupId: input.segmentGroupId,
    groupIndex: input.groupIndex, sequence: input.sequence, configId: input.configId }), 'voice.synthesize')
  let raw
  try { raw = await client.post(endpoint, body, signal) }
  catch (error) {
    const outcome = error instanceof OperationFailure ? error.details.outcome : 'unknown'
    const message = error instanceof Error ? error.message : String(error)
    operations.finish(id, outcome, message)
    throw new OperationFailure(`语音合成${outcome === 'failed' ? '失败' : '结果未确认'}：${message}`, {
      ...(error instanceof MonHttpError ? error.details : { endpoint }), kind: 'speech_synthesis', outcome,
      // A lost response may hide successful generation. Do not start a new automatic operation.
      retryable: error instanceof MonHttpError && error.details.retryable && outcome === 'failed',
    }, { cause: error })
  }
  const parsed = resultSchema.safeParse(raw)
  if (!parsed.success) {
    operations.finish(id, 'unknown', 'Core returned an invalid speech response')
    throw new OperationFailure('Core 返回的语音结果无法确认，请核对后手动重试。', { kind: 'speech_synthesis', endpoint, outcome: 'unknown', retryable: false })
  }
  if (!parsed.data.success) {
    const message = coreSpeechFailure(raw)
    operations.finish(id, 'failed', message)
    throw new OperationFailure(`语音合成失败：${message}`, { kind: 'speech_synthesis', endpoint, outcome: 'failed', retryable: false })
  }
  operations.finish(id, 'applied')
  if (!parsed.data.audio_url) throw new Error('Mon speech response has no downloadable audio')
  const audio = await client.fetchAudio(parsed.data.audio_url, signal)
  return { ...audio, durationMs: parsed.data.duration_ms ?? null }
}
