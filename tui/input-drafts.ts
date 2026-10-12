import { displayText, graphemes } from './screen-text.ts'
import type { InputMode } from './terminal-input.ts'

export interface InputSubmission { text: string; scope: string | undefined; epoch: number; generation: number }
type Draft = { input: string; cursor: number; history: string[] }

/** Editor state stays in memory and never saves passwords or crosses an account reset. */
export class InputDrafts {
  protected input = ''
  protected cursor = 0
  protected inputMode: InputMode = 'normal'
  protected savedDraft = ''
  protected history: string[] = []
  protected historyIndex = -1
  private historyDraft = ''
  private scope: string | undefined
  private epoch = 0
  private generation = 0
  private readonly drafts = new Map<string | undefined, Draft>()
  private readonly failed = new Map<string | undefined, string>()

  protected inputEdited(): void { this.epoch++ }

  protected selectDraft(scope: string | undefined): void {
    if (this.scope === scope) return
    if (this.inputMode === 'normal') this.drafts.set(this.scope, {
      input: this.input, cursor: this.cursor, history: [...this.history],
    })
    this.scope = scope
    const draft = this.drafts.get(scope)
    this.input = draft?.input ?? ''
    this.cursor = draft?.cursor ?? 0
    this.history = [...(draft?.history ?? [])]
    this.historyIndex = -1
    this.savedDraft = ''
    if (this.drafts.size > 100) this.drafts.delete(this.drafts.keys().next().value)
  }

  protected changeInputMode(mode: InputMode): void {
    if (mode === this.inputMode && mode === 'normal') return
    this.inputMode = mode
    this.input = ''; this.cursor = 0
    this.inputEdited()
  }

  protected clearInputDrafts(): void {
    this.generation++
    this.drafts.clear(); this.failed.clear()
    this.scope = undefined
    this.input = ''; this.cursor = 0; this.savedDraft = ''; this.history = []; this.historyIndex = -1
    this.inputEdited()
  }

  protected insertInput(value: string): boolean {
    const clean = this.inputMode === 'password'
      ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, Math.max(0, 4096 - this.input.length)) : displayText(value)
    if (!clean) return false
    const points = graphemes(this.input)
    points.splice(this.cursor, 0, ...graphemes(clean))
    this.input = points.join(''); this.cursor += graphemes(clean).length
    this.inputEdited()
    return true
  }

  protected takeInput(answering: boolean): { value: string; submission?: InputSubmission } | undefined {
    const value = this.inputMode === 'password' ? this.input : this.input.trim()
    if (!value && this.inputMode === 'normal') return
    const message = !value.startsWith('/') || value.startsWith('//') || /^\/(steer|followup)\s/.test(value)
    const recoverable = this.inputMode === 'normal' && !answering && message
    this.input = ''; this.cursor = 0; this.historyIndex = -1
    this.inputEdited()
    if (recoverable && (!value.startsWith('/') || value.startsWith('//'))) {
      if (this.history.at(-1) !== value) this.history.push(value)
      if (this.history.length > 100) this.history.shift()
    }
    return { value, ...(recoverable ? { submission: { text: value, scope: this.scope,
      epoch: this.epoch, generation: this.generation } } : {}) }
  }

  protected recoverInput(submission: InputSubmission, automatic: boolean, target?: string): boolean | undefined {
    if (submission.generation !== this.generation) return undefined
    const scope = submission.scope ?? target
    this.failed.set(scope, submission.text)
    if (this.failed.size > 100) this.failed.delete(this.failed.keys().next().value)
    if (!automatic || this.inputMode !== 'normal' || this.scope !== scope || this.input || this.epoch !== submission.epoch) return false
    this.input = submission.text; this.cursor = graphemes(this.input).length
    this.failed.delete(scope)
    this.inputEdited()
    return true
  }

  protected restoreFailedInput(): void {
    if (this.inputMode !== 'normal') throw new Error('请先完成登录')
    if (this.input.trim() && this.input.trim() !== '/restore') throw new Error('当前已有草稿，请先保存或清空')
    const value = this.failed.get(this.scope)
    if (!value) throw new Error('当前会话没有待恢复的输入')
    this.input = value; this.cursor = graphemes(value).length
    this.failed.delete(this.scope)
    this.inputEdited()
  }

  protected navigateHistory(direction: -1 | 1): void {
    if (!this.history.length) return
    if (this.historyIndex < 0) { this.historyDraft = this.input; this.historyIndex = this.history.length }
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction))
    this.input = this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex] ?? ''
    this.cursor = graphemes(this.input).length
    this.inputEdited()
  }
}
