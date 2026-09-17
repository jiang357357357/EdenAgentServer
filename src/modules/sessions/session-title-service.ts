import { completeText, TextCompletionError } from '@eden/runtime-pi'
import type { RuntimeModel } from '@eden/runtime-pi'
import type { SessionRepository } from './session-repository.ts'

const TITLE_PROMPT = [
  '根据用户消息为本次对话生成一个简短、明确的标题。',
  '只输出一行自然语言标题，不要引号、前缀、解释、Markdown 或代码。',
  '使用用户消息的语言。中文约 10 个汉字，其他语言约 5 个词。',
].join('\n')

function cleanTitle(value: string, maxCharacters: number): string {
  const cleaned = value
    // oxlint-disable-next-line no-control-regex -- displayed titles must discard terminal OSC escapes
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|$)/gu, '')
    // oxlint-disable-next-line no-control-regex -- displayed titles must discard terminal CSI escapes
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    // oxlint-disable-next-line no-control-regex -- remaining control and bidi characters are not title text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(?:标题|title)\s*[:：]\s*/iu, '')
    .replace(/^["'“‘`]+|["'”’`]+$/gu, '')
    .trim()
  return Array.from(cleaned).slice(0, maxCharacters).join('').trim()
}

export function fallbackSessionTitle(text: string): string {
  return cleanTitle(text, 32)
}

export function generatedSessionTitle(text: string): string {
  return cleanTitle(text, 48)
}

export class SessionTitleService {
  private readonly tasks = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private closing = false

  constructor(private readonly sessions: SessionRepository,
    private readonly resolveModel: (sessionId: string) => RuntimeModel | undefined) {}

  schedule(sessionId: string, turnId: string, userText: string): void {
    if (this.closing || this.tasks.has(sessionId)) return
    const fallback = fallbackSessionTitle(userText)
    if (!fallback || !this.sessions.setFallbackTitle(sessionId, fallback, turnId)) return
    const model = this.resolveModel(sessionId)
    if (!model) return
    const controller = new AbortController()
    const promise = this.generate(sessionId, turnId, userText, model, controller.signal)
      .catch(error => {
        if (controller.signal.aborted || this.closing) return
        this.sessions.events.append(sessionId, turnId, 'session.title_generation_failed', {
          message: error instanceof TextCompletionError ? 'Model title request failed' : String(error).slice(0, 500),
        })
      })
      .finally(() => {
        if (this.tasks.get(sessionId)?.promise === promise) this.tasks.delete(sessionId)
      })
    this.tasks.set(sessionId, { controller, promise })
  }

  private async generate(sessionId: string, turnId: string, userText: string, model: RuntimeModel, signal: AbortSignal): Promise<void> {
    const title = generatedSessionTitle(await completeText({
      model: { ...model, maxTokens: Math.min(model.maxTokens, 64), reasoning: 'off' },
      systemPrompt: TITLE_PROMPT,
      text: JSON.stringify({ userMessage: Array.from(userText).slice(0, 4096).join('') }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      record: async snapshot => {
        this.sessions.events.append(sessionId, turnId, 'session.title_model_request', snapshot)
      },
    }))
    if (title) this.sessions.setGeneratedTitle(sessionId, title, turnId)
  }

  cancel(sessionId: string): void {
    this.tasks.get(sessionId)?.controller.abort(new Error('Session title generation cancelled'))
  }

  async close(): Promise<void> {
    this.closing = true
    for (const task of this.tasks.values()) task.controller.abort(new Error('Session title service is closing'))
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise))
  }
}
