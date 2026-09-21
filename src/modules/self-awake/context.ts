import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { MonClient, acquireMonServiceToken } from '@eden/integrations'
import type { MonServiceIdentity } from '@eden/integrations'
import type { SessionRepository } from '../sessions/index.ts'
import type { SelfAwakeRepository } from './repository.ts'
import { selfAwakePromptContext } from './prompt.ts'
import { SELF_AWAKE_INTERPRETATIONS } from '../../model-prompts/self-awake.ts'

export const selfAwakeContextSchema = z.object({
  section: z.enum(['request', 'desktop_window', 'desktop_session', 'audio_state', 'recent_events', 'recent_diaries', 'wake_notes']).default('request'),
  limit: z.number().int().min(1).max(5).default(3),
  includeContent: z.boolean().default(false),
  query: z.string().trim().min(1).max(200).optional(),
}).strict()

export class SelfAwakeContext {
  constructor(private readonly repository: SelfAwakeRepository, private readonly sessions: SessionRepository, private readonly identity?: MonServiceIdentity) { }
  async read(sessionId: string, turnId: string, raw: unknown, signal: AbortSignal): Promise<JsonValue> {
    const input = selfAwakeContextSchema.parse(raw)
    signal.throwIfAborted()
    const session = this.sessions.read(sessionId)
    if (session.status !== 'active') throw new Error('Self-awake context requires an active session')
    if (input.section === 'request') return modelSelfAwakeContext(toJson(this.repository.context(sessionId, turnId)))
    if (input.section === 'wake_notes') {
      const context = this.repository.context(sessionId, turnId)
      return toJson({ source: 'wake_schedule', wakeSchedule: selfAwakePromptContext({ wakeSchedule: context.wakeSchedule }).wakeSchedule })
    }
    const environment = object(session.environment)
    const owner = this.sessions.origin === 'mon' && this.identity && environment.sessionPurpose === 'self_awake' && environment.selfAwakeUserId === this.identity.userId
      && this.repository.ownsBackgroundSession(sessionId, this.identity.userId) ? this.identity : undefined
    const user = owner?.userId ?? ''
    if (input.section === 'recent_diaries') return this.history(sessionId, user, input)
    if (!owner) throw new Error('Personal activity context requires the owning Mon background session')
    return await activityContext(owner, signal, input)
  }
  private history(sessionId: string, user: string, input: z.infer<typeof selfAwakeContextSchema>): JsonValue {
    if (input.section === 'recent_diaries') return toJson({
      section: input.section, source: 'agent.diaries',
      diaries: this.repository.recentDiaries(sessionId, user, input.limit).map(({ content, ...entry }) => ({ ...entry, ...(input.includeContent && input.query && typeof content === 'string' && content.includes(input.query) ? { content } : { contentAvailable: Boolean(content) }) })), interpretation: SELF_AWAKE_INTERPRETATIONS.diaries
    })
    throw new Error('Unknown history section')
  }

}
async function activityContext(owner: MonServiceIdentity, signal: AbortSignal, input: z.infer<typeof selfAwakeContextSchema>) {
  const token = await acquireMonServiceToken(owner, signal)
  const snapshot = object(await new MonClient(owner.coreBaseUrl, token).get('/api/users/me/activity-presence/?fresh=1', signal))
  const payload = snapshot.fresh === true && snapshot.available === true ? object(snapshot.payload) : {}
  const fields: Record<string, string[]> = { desktop_window: ['foreground_window'], desktop_session: ['system_input', 'session'], audio_state: ['media'], recent_events: ['recent_events'] }
  const data = Object.fromEntries(fields[input.section]!.map(key => [key, payload[key] ?? null]))
  if (input.section === 'audio_state') {
    const agent = object(payload.monagent)
    data.monagent = { voice_recording: agent.voice_recording ?? null, tts_playing: agent.tts_playing ?? null }
  }
  const captured = typeof snapshot.captured_at === 'string' ? Date.parse(snapshot.captured_at) : NaN
  const age = Number.isFinite(captured) ? Math.max(0, Date.now() - captured) : null
  return toJson({
    section: input.section, source: 'core.activity-presence', available: snapshot.available === true && snapshot.fresh === true, fresh: snapshot.fresh === true, error: snapshot.error ?? null,
    captured_at: snapshot.captured_at ?? null, received_at: snapshot.received_at ?? null, ageMs: age, stale: snapshot.fresh !== true || age === null || age > 180000, data,
    interpretation: SELF_AWAKE_INTERPRETATIONS.activity
  })
}

function object(value: unknown): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {} }

/** Project only model tool output; persisted audit snapshots remain complete. */
export function modelSelfAwakeContext(value: JsonValue): JsonValue {
  const context = object(value)
  if (!context.run) return value
  const run = object(context.run), request = object(run.request)
  return { ...selfAwakePromptContext({ ...request, current_time: context.current_time ?? request.current_time ?? null,
    wakeSchedule: context.wakeSchedule ?? request.wakeSchedule ?? null }),
    run: { id: run.id ?? null, status: run.status ?? null } }
}
