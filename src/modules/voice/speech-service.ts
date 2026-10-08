import { SynthesisJobs } from './synthesis-jobs.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { VoiceSynthesizeInput } from '@eden/api'
import { OperationFailure, voiceSynthesizeSchema, voiceSegmentsSchema, voiceCancelSchema } from '@eden/api'
import type { BlobService } from '../blobs/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { VoiceConfigRepository } from './config-repository.ts'
import type { SpeechRepository } from './speech-repository.ts'
import { synthesizeGsv } from './gsv-synthesis.ts'
import { SynthesisBudget } from './synthesis-budget.ts'
type MonSynthesis = (input: VoiceSynthesizeInput, signal: AbortSignal) => Promise<{ bytes: Buffer; mime: string; durationMs: number | null }>
type CachedAudio = NonNullable<ReturnType<SpeechRepository['cached']>>
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class SpeechService {
  private readonly abort = new AbortController()
  private readonly pending: SynthesisJobs<CachedAudio>
  private readonly budget: SynthesisBudget
  constructor(private readonly repository: SpeechRepository, private readonly sessions: SessionRepository,
    private readonly config: VoiceConfigRepository, private readonly blobs: BlobService, private readonly monSynthesis: MonSynthesis,
    limits?: ConstructorParameters<typeof SynthesisJobs>[0]) { this.budget = new SynthesisBudget(sessions); this.pending = new SynthesisJobs(limits) }
  list(raw: unknown) {
    const input = voiceSegmentsSchema.parse(raw)
    this.sessions.read(input.sessionId)
    return this.repository.list(input.sessionId, input.messageId)
  }
  cancel(raw: unknown) {
    const input = voiceCancelSchema.parse(raw)
    this.sessions.read(input.sessionId)
    return { cancelled: this.pending.cancel(`${input.sessionId}:${input.requestId}`) }
  }
  async synthesize(raw: unknown) {
    const { requestId, intent, ...content } = voiceSynthesizeSchema.parse(raw)
    const input = { ...content, ...(intent ? { intent } : {}) }
    this.abort.signal.throwIfAborted()
    const session = this.sessions.read(input.sessionId)
    this.budget.prepare(input); this.budget.check(input)
    const config = session.runtimeOrigin === 'local' ? this.config.read().tts : undefined
    const key = hash(JSON.stringify(config ? { config, text: input.text, mode: input.mode, configId: String(input.configId) } : { origin: 'mon', input: content }))
    const cached = this.repository.cached(key)
    const synthesis = () => this.pending.run(key, `${input.sessionId}:${requestId ?? randomUUID()}`, async signal => {
      signal.throwIfAborted()
      this.budget.check(input)
      let audio
      try { audio = await (config ? synthesizeGsv(config, input.text, signal) : this.monSynthesis(input, signal)) }
      catch (error) { if (!signal.aborted) this.budget.failed(input, error); throw error }
      signal.throwIfAborted()
      const blob = await this.blobs.put(audio.bytes, audio.mime)
      signal.throwIfAborted()
      const result = { blobId: blob.id, durationMs: audio.durationMs, sizeBytes: audio.bytes.length,
        format: audio.mime === 'audio/mpeg' ? 'mp3' : audio.mime.replace('audio/', '').replace('x-wav', 'wav') }
      this.repository.save(key, result)
      return result
    })
    let audio = cached
    if (!audio) {
      try { audio = await synthesis() }
      catch (error) {
        // Queue deadlines reject independently of an upstream that ignores cancellation.
        if (error instanceof OperationFailure && ['speech_timeout', 'speech_queue_full'].includes(error.details.kind)) this.budget.failed(input, error)
        throw error
      }
    }
    this.abort.signal.throwIfAborted()
    this.sessions.read(input.sessionId)
    const id = this.repository.segment(input, key, hash(input.text))
    return { success: true, audio_blob_id: audio.blobId, audio_url: null, text: input.text, cached: Boolean(cached), cache_key: key,
      audio_format: audio.format, duration_ms: audio.durationMs, size_bytes: audio.sizeBytes, speech_segment_id: id,
      segment_group_id: input.segmentGroupId, group_index: input.groupIndex, sequence: input.sequence }
  }
  async close() { this.abort.abort(); await this.pending.close() }
}
