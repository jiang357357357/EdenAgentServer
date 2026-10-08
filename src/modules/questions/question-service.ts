import { questionAskSchema, questionResolveSchema } from '@eden/api'
import type { QuestionItem } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'
import { QuestionRepository } from './question-repository.ts'
import { validatedQuestionAnswers } from './question-answers.ts'

interface Waiter { resolve(answers: string[][]): void; reject(error: unknown): void }

export class QuestionService {
  private readonly repository: QuestionRepository
  private readonly pending = new Map<string, Waiter>()
  private closed = false
  constructor(sessions: SessionRepository) {
    this.repository = new QuestionRepository(sessions)
    for (const request of this.repository.pending()) this.finish(request.id, 'interrupted')
  }

  async ask(sessionId: string, turnId: string, raw: unknown, signal: AbortSignal): Promise<string[][]> {
    if (this.closed) throw new Error('Question service is shutting down')
    signal.throwIfAborted()
    const { questions } = questionAskSchema.parse(raw)
    validateQuestions(questions)
    const { request, event } = this.repository.create(sessionId, turnId, questions)
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener('abort', abort); this.pending.delete(request.id) }
      const abort = () => {
        try { this.finish(request.id, 'cancelled') }
        catch (error) { cleanup(); reject(error) }
      }
      this.pending.set(request.id, { resolve: answers => { cleanup(); resolve(answers) }, reject: error => { cleanup(); reject(error) } })
      signal.addEventListener('abort', abort, { once: true })
      this.repository.sessions.events.publish(event)
      if (signal.aborted && this.pending.has(request.id)) abort()
    })
  }

  list(sessionId?: string) { return this.repository.pending(sessionId) }

  resolve(id: string, rawAnswers: string[][], rawSupplementary?: string[]) {
    const { answers, supplementary } = questionResolveSchema.parse({ requestId: id, answers: rawAnswers, supplementary: rawSupplementary })
    const request = this.repository.read(id)
    const combined = validatedQuestionAnswers(request.questions, answers, supplementary)
    return this.finish(id, 'answered', combined)
  }

  reject(id: string) { return this.finish(id, 'rejected') }

  private finish(id: string, state: 'answered' | 'rejected' | 'cancelled' | 'interrupted', answers?: string[][]) {
    const { request, event } = this.repository.finish(id, state, answers)
    const waiter = this.pending.get(id)
    if (state === 'answered') waiter?.resolve(answers!)
    else waiter?.reject(new Error(`Question ${state}`))
    this.repository.sessions.events.publish(event)
    return request
  }

  close(): void {
    this.closed = true
    const failures: unknown[] = []
    for (const [id, waiter] of this.pending) {
      try { this.finish(id, 'interrupted') }
      catch (error) { waiter.reject(error); failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Question shutdown persistence failed')
  }
}

function validateQuestions(questions: QuestionItem[]): void {
  for (const question of questions) {
    if (!question.custom && !question.options.length) throw new Error('A question requires options or a custom answer')
    if (new Set(question.options.map(option => option.label)).size !== question.options.length) throw new Error('Duplicate question option')
  }
}
