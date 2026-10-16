import { toJson, type JsonValue } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'
import type { SelfAwakeRepository } from './repository.ts'
import { SelfAwakeHistoryRepository } from './history-repository.ts'
import { historyScopeView, selfAwakeHistoryScope } from './history-scope.ts'
import { selfAwakePromptContext } from './prompt.ts'
import { SELF_AWAKE_HISTORY_NOTES, SELF_AWAKE_INTERPRETATIONS } from '../../model-prompts/self-awake.ts'

interface HistoryInput { section: string; limit: number; includeContent: boolean; query?: string | undefined }

export class SelfAwakeHistory {
  private readonly repository: SelfAwakeHistoryRepository
  constructor(private readonly awake: SelfAwakeRepository, private readonly sessions: SessionRepository) {
    this.repository = new SelfAwakeHistoryRepository(sessions.database)
  }

  read(sessionId: string, turnId: string, input: HistoryInput, actorId?: string | number): JsonValue {
    const scope = selfAwakeHistoryScope(this.sessions, sessionId, turnId, actorId)
    const view = historyScopeView(scope)
    const interpretation = SELF_AWAKE_HISTORY_NOTES[scope.kind]
    if (input.section === 'recent_diaries') {
      const { rows, count, totalCount } = this.repository.diaries(scope, input.query ?? '', input.limit)
      const full = input.includeContent && Boolean(input.query)
      return toJson({ section: input.section, source: 'agent.diaries', scope: view, count, totalCount, hasMore: count > rows.length,
        contentMode: full ? 'full' : 'directory', ...(input.includeContent && !input.query ? { contentReason: SELF_AWAKE_HISTORY_NOTES.query } : {}),
        diaries: rows.map(row => ({ id: String(row.id), assistantId: String(row.assistant_id), characterId: String(row.character_id),
          title: String(row.title), createdAt: Number(row.created_at),
          ...(full ? { content: String(row.content) } : { contentAvailable: Boolean(row.content) }) })),
        ...(count === 0 ? { emptyReason: totalCount ? 'no_matching_diaries' : 'no_diaries_in_scope' } : {}),
        interpretation: `${interpretation}\n${SELF_AWAKE_INTERPRETATIONS.diaries}` })
    }
    const targets = this.repository.sessions(scope)
    const unique = [...new Set(targets.ids.map(id => this.awake.roles.target(id)))]
    const schedules = unique.map(id => this.awake.wakeSchedule(id)).filter(value => value !== null)
    const scheduled = schedules.filter(value => value.status === 'scheduled').sort((a, b) => String(a.nextWakeAt).localeCompare(String(b.nextWakeAt)))
    const unavailable = schedules.find(value => value.status === 'unavailable')
    const fallback = unavailable ?? schedules.find(value => value.status === 'disabled') ?? schedules[0]
    const summary = scheduled[0] ?? (targets.truncated ? { status: 'unavailable', nextWakeAt: null, reason: SELF_AWAKE_HISTORY_NOTES.limit } : fallback)
      ?? { status: 'unscheduled', nextWakeAt: null, reason: SELF_AWAKE_HISTORY_NOTES.emptySchedule }
    return toJson({ source: 'wake_schedule', scope: view, interpretation, coverage: 'role_plan',
      truncated: targets.truncated, scheduledCount: scheduled.length, unavailableCount: schedules.filter(value => value.status === 'unavailable').length,
      wakeSchedule: selfAwakePromptContext({ wakeSchedule: toJson(summary) }).wakeSchedule,
      schedules: scheduled.slice(0, 20).map(value => selfAwakePromptContext({ wakeSchedule: toJson(value) }).wakeSchedule),
      hasMore: scheduled.length > 20 })
  }
}
