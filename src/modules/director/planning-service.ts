import { completeText, TextCompletionError } from '@eden/runtime-pi'
import type { RuntimeModel } from '@eden/runtime-pi'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'
import { DirectorRunRepository } from './run-repository.ts'
import { directorRoster } from './roster.ts'
import { parseDirectorPlan } from './plan.ts'
import { DIRECTOR_SYSTEM_PROMPT } from '../../model-prompts/director.ts'

export interface PlanningRequest {
  sessionId: string; turnId: string; userText: string; participants: JsonValue[]
  conversation: string; attachments: string; model: RuntimeModel; signal: AbortSignal
  userMessageID?: string
}

export class DirectorPlanningService {
  constructor(private readonly sessions: SessionRepository, private readonly runs: DirectorRunRepository) {}

  async plan(request: PlanningRequest) {
    this.sessions.read(request.sessionId)
    const roster = directorRoster(request.participants)
    request.signal.throwIfAborted()
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60000)])
    let diagnostic: string | undefined
    const text = roster.length === 1 ? '' : await completeText({ model: request.model, systemPrompt: DIRECTOR_SYSTEM_PROMPT, signal,
      text: JSON.stringify({ participants: roster, recentConversation: request.conversation, userMessage: request.userText, attachmentContext: request.attachments }),
      record: async snapshot => { this.sessions.events.append(request.sessionId, request.turnId, 'director.model.request', snapshot) },
    }).catch(error => {
      request.signal.throwIfAborted()
      if (!(error instanceof TextCompletionError) && error !== signal.reason) throw error
      diagnostic = signal.aborted ? 'director_request_timeout' : 'director_request_failed'
      return ''
    })
    request.signal.throwIfAborted()
    const plan = parseDirectorPlan(text, roster, request.userText)
    if (diagnostic) plan.diagnostic = diagnostic
    // The hidden raw response never enters the public conversation history.
    this.sessions.events.append(request.sessionId, request.turnId, 'director.model.result', toJson({ source: plan.source, diagnostic: plan.diagnostic ?? null }))
    return this.runs.create(request.sessionId, request.turnId, plan, roster.length, request.userMessageID, request.participants)
  }
}
