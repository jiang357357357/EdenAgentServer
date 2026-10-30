import { isSignedThinking } from '@eden/api'
import { mapHistoryContent } from '@eden/runtime-pi'
import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import { HOST_IDENTIFIER_HIDDEN } from '../../model-prompts/tool-results.ts'
import { historicalModelResult, projectRecordedResult } from './model-result-catalog.ts'
import { privateQqHistoryEntries } from './qq-history-privacy.ts'
import { checkpointSummaryBoundary } from './checkpoint-summaries.ts'
import { legacyModelEnvelope, legacyMessageBody } from './legacy-results.ts'
import { ResultIdentifiers } from './model-fields.ts'
import { modelUserHistory } from './user-context-history.ts'
import { knownValueProjection } from './known-value-projection.ts'

const object = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

function textProjector(hidden: ResultIdentifiers) {
  const values = [...hidden].filter(value => !hidden.business.has(value)).map(value => [value, HOST_IDENTIFIER_HIDDEN] as const)
  const project = knownValueProjection(new Map(values), 8)
  return (text: string) => project(text) as string
}

function modelText(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (typeof value === 'string') return redact(value)
  if (!Array.isArray(value)) return value
  return value.map(block => {
    const part = object(block)
    if (!part || isSignedThinking(part)) return block
    const next = { ...part }
    for (const key of ['text', 'thinking']) if (typeof next[key] === 'string') next[key] = redact(next[key])
    return next
  })
}

function redactMessage(fields: Record<string, JsonValue>, redact: (text: string) => string) {
  const next = { ...fields }
  if ((fields.role === 'assistant' || (fields.role === 'toolResult' && fields.isError === true)) && fields.content !== undefined)
    next.content = modelText(fields.content, redact)
  if (typeof fields.summary === 'string') next.summary = redact(fields.summary)
  if (fields.role === 'assistant' && typeof fields.text === 'string') next.text = redact(fields.text)
  return next
}

/** One traversal owns call provenance and the exact internal values removed from host envelopes. */
class HistoryProjection {
  private readonly hidden = new ResultIdentifiers()
  private readonly calls = new Map<string, Record<string, unknown>>()
  private readonly sources = new Map<string, string>()
  private readonly receipts = new Map<string, { toolName: string; result: JsonValue; input: Record<string, unknown> | undefined } | null>()

  run(history: JsonValue[], receipts: JsonValue[]) {
    this.collectReceipts(receipts)
    const all = [...receipts, ...history]
    all.forEach(value => this.collectCalls(value))
    // QQ collects platform identifiers before other projections remove their source fields.
    const projected = privateQqHistoryEntries(all).map(value => this.projectNode(value))
    const redact = textProjector(this.hidden)
    return projected.slice(receipts.length).map(value => this.redactNode(value, redact))
  }

  private collectReceipts(receipts: JsonValue[]): void {
    for (const receipt of receipts) {
      const message = object(object(receipt)?.message)
      if (!message || typeof message.toolCallId !== 'string' || typeof message.toolName !== 'string' || message.details === undefined) continue
      const id = message.toolCallId
      this.receipts.set(id, this.receipts.has(id) ? null : { toolName: message.toolName, result: message.details,
        input: object(object(receipt)?.modelInput) })
    }
  }

  private collectCalls(value: JsonValue): void {
    if (Array.isArray(value)) { value.forEach(item => this.collectCalls(item)); return }
    const fields = object(value)
    if (!fields) return
    this.collectSource(fields)
    if (fields.type === 'toolCall' && typeof fields.id === 'string' && object(fields.arguments)) this.calls.set(fields.id, object(fields.arguments)!)
    for (const key of ['message', 'payload', 'content', 'retainedTail']) {
      const child = fields[key]
      if (child !== undefined && typeof child !== 'string') this.collectCalls(child)
    }
    if (fields.type === 'custom_message' && typeof fields.content === 'string')
      mapHistoryContent(fields.content, child => { this.collectCalls(child); return child })
  }

  private collectSource(fields: Record<string, JsonValue>) {
    if (fields.role === 'toolResult' && typeof fields.toolName === 'string' && typeof fields.modelSource === 'string') {
      const previous = this.sources.get(fields.toolName)
      if (previous && previous !== fields.modelSource) throw new Error('历史同名工具的结果归属存在歧义，需复核上下文')
      this.sources.set(fields.toolName, fields.modelSource)
    }
  }

  private projectMessage(message: Record<string, JsonValue>, input?: Record<string, unknown>): JsonValue {
    if (message.role === 'user' && message.content !== undefined)
      return { ...message, content: modelUserHistory(message.content, value => this.projectNode(value), this.hidden) }
    if (message.role !== 'toolResult' || typeof message.toolName !== 'string') return message
    const args = this.callInput(message, input)
    const source = this.sources.get(message.toolName)
    const project = (value: JsonValue) => projectRecordedResult(message.toolName as string, value, args, this.hidden, source)
    let recovered: JsonValue | undefined
    const recover = () => { recovered = this.recoverResult(message, project); return recovered }
    const next = { ...message }
    if (message.details !== undefined) next.details = project(message.details)
    if (Array.isArray(message.content)) next.content = message.content.map(block => this.projectBlock(block, message, source, project, recover))
    if (recovered !== undefined) next.details = recovered
    return next
  }

  private projectBlock(block: JsonValue, message: Record<string, JsonValue>, source: string | undefined,
    project: (value: JsonValue) => JsonValue, recover: () => JsonValue) {
    const part = object(block)
    if (part?.type !== 'text' || typeof part.text !== 'string') return block
    let value: JsonValue
    try { value = JSON.parse(part.text) as JsonValue }
    catch (error) {
      if (message.isError !== true && historicalModelResult(message.toolName as string, {}, source)) {
        try { return { ...part, text: JSON.stringify(recover()) } }
        catch (cause) { throw new Error('历史工具结果损坏且无法从唯一审计回执恢复，需复核上下文', { cause: new AggregateError([error, cause]) }) }
      }
      return block
    }
    if (message.isError === true && object(value)?.result !== undefined)
      return { ...part, text: JSON.stringify({ outcome: object(value)!.outcome ?? 'failed', result: project(object(value)!.result!) }) }
    return { ...part, text: JSON.stringify(project(value)) }
  }

  private recoverResult(message: Record<string, JsonValue>, project: (value: JsonValue) => JsonValue): JsonValue {
    const receipt = this.receipts.get(String(message.toolCallId))
    if (!receipt || receipt.toolName !== message.toolName) throw new Error('历史工具调用缺少唯一匹配的原始回执')
    // Rebuild only the model view. The original audit is never copied into a request or executed again.
    return project(receipt.result)
  }

  private callInput(message: Record<string, JsonValue>, input?: Record<string, unknown>) {
    if (input) return input
    const receipt = this.receipts.get(String(message.toolCallId))
    if (receipt && receipt.toolName === message.toolName && receipt.input) return receipt.input
    return this.calls.get(String(message.toolCallId))
  }

  private projectNode(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(item => this.projectNode(item))
    const fields = object(value)
    if (!fields) return value
    if (typeof fields.role === 'string') return this.projectMessage(fields)
    const next = legacyModelEnvelope(fields, this.hidden)
    if (object(next.message)) next.message = this.projectMessage(object(next.message)!, object(fields.modelInput))
    if (object(next.payload)) next.payload = this.projectNode(next.payload!)
    if (typeof fields.sourceEventId === 'string' && object(next.payload)?.message)
      object(next.payload)!.message = legacyMessageBody(object(next.payload)!.message!, this.hidden)
    if (next.retainedTail) next.retainedTail = this.projectNode(next.retainedTail)
    if (next.type === 'custom_message' && typeof next.content === 'string') next.content = mapHistoryContent(next.content, child => this.projectNode(child))
    return next
  }

  private redactNode(value: JsonValue, redact: (text: string) => string): JsonValue {
    if (Array.isArray(value)) return value.map(item => this.redactNode(item, redact))
    const fields = object(value)
    if (!fields) return value
    const next = redactMessage(fields, redact)
    for (const key of ['message', 'payload', 'retainedTail']) if (fields[key]) next[key] = this.redactNode(fields[key]!, redact)
    if (fields.type === 'custom_message' && typeof fields.content === 'string') next.content = mapHistoryContent(fields.content, child => this.redactNode(child, redact))
    if (fields.role === 'user' && fields.content !== undefined)
      next.content = modelUserHistory(fields.content, child => this.redactNode(child, redact))
    return next
  }
}

/** SDK entry IDs, parents and tool-call pairing remain host protocol facts. */
export function privateToolHistoryEntries(history: JsonValue[], receipts: JsonValue[] = []): JsonValue[] {
  return new HistoryProjection().run(history, receipts)
}

export function privateToolCheckpoint(checkpoint: RuntimeCheckpoint, receipts: JsonValue[] = [], restoring = false): RuntimeCheckpoint {
  const projected = { ...checkpoint, entries: privateToolHistoryEntries(checkpoint.entries, receipts) }
  return checkpointSummaryBoundary(projected, restoring)
}
