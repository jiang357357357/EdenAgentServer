import type { MemoryRecord } from '@eden/api'
import type { MemoryRepository } from './repository.ts'
import type { MemoryScopes } from './scope.ts'
import { MEMORY_RECALL_HEADING, MEMORY_RECALL_UNAVAILABLE } from '../../model-prompts/memory.ts'
import { logDiagnostic } from '../logging/index.ts'
import { validUntil } from './retrieval.ts'
import type { MemoryRetriever } from './retrieval.ts'
import { memoryRecallFailure } from './recall-diagnostics.ts'

function fragments(query: string): string[] {
  const lower = Array.from(query).slice(0, 8192).join('').toLowerCase()
  const result = new Set(lower.split(/[^\p{L}\p{N}]+/u).filter(word => Array.from(word).length >= 2).slice(0, 256))
  const characters = Array.from(lower).filter(character => !/\s/u.test(character))
  for (let index = 0; index < Math.min(256, characters.length - 1); index++) result.add(characters[index]! + characters[index + 1]!)
  return [...result]
}

/** Historical lexical baseline retained for comparison tests, not automatic recall. */
export function selectMemories(candidates: readonly MemoryRecord[], query: string): MemoryRecord[] {
  const terms = fragments(query)
  const ranked = candidates.map(memory => {
    const lower = memory.content.toLowerCase()
    return { memory, score: terms.filter(term => lower.includes(term)).length }
  }).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt - left.memory.updatedAt || right.memory.id - left.memory.id)
  const selected: MemoryRecord[] = []
  let remaining = 4000
  for (const { memory } of ranked) {
    if (selected.length >= 5 || remaining <= 0) break
    const characters = Array.from(memory.content.replaceAll('\0', '').trim())
    if (!characters.length) continue
    const limit = Math.min(remaining, 1200)
    const content = characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('')
    remaining -= Array.from(content).length
    selected.push({ ...memory, content })
  }
  return selected
}

export class MemoryRecall {
  constructor(private readonly repository: MemoryRepository, private readonly scopes: MemoryScopes, private readonly retrieve: MemoryRetriever) {}

  async prompt(sessionId: string, turnId: string, text: string, actorId?: string | number, signal?: AbortSignal): Promise<string> {
    const scope = this.scopes.optionalCurrent(sessionId, turnId, actorId)
    if (!scope || !text.trim()) return ''
    const candidates = this.repository.recallCandidates(scope).filter(memory => (validUntil(memory) ?? Infinity) > Date.now())
    if (!candidates.length) return ''
    const started = performance.now()
    const facts = { sessionId, turnId, scopeType: scope.scopeType, characterId: scope.scopeKey, candidateCount: candidates.length }
    const duration = () => ({ ...facts, durationMs: Math.round((performance.now() - started) * 100) / 100 })
    logDiagnostic({ event: 'memory.recall.started', ...facts })
    let stage: 'retrieval' | 'selection' = 'retrieval'
    let selected: { memory: MemoryRecord; excerpt?: string }[]
    try {
      const retrievalSignal = AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])])
      const matches = await this.retrieve({ sessionId, scope, query: text, candidates, signal: retrievalSignal })
      retrievalSignal.throwIfAborted()
      stage = 'selection'
      const allowed = new Map(candidates.map(memory => [memory.id, memory]))
      selected = matches.map(match => {
        const memory = allowed.get(match.id)
        if (!memory || !Number.isFinite(match.similarity) || (match.excerpt !== undefined && (!match.excerpt.trim() || !memory.content.includes(match.excerpt)))) throw new Error('Invalid memory selection')
        allowed.delete(match.id)
        return { memory, ...(match.excerpt ? { excerpt: match.excerpt } : {}) }
      })
    } catch (error) {
      if (signal?.aborted) logDiagnostic({ event: 'memory.recall.cancelled', ...duration() })
      signal?.throwIfAborted()
      logDiagnostic({ event: 'memory.recall.unavailable', message: '本轮自动长期记忆召回不可用', ...duration(), ...memoryRecallFailure(error, stage) }, 'warn')
      return MEMORY_RECALL_UNAVAILABLE
    }
    signal?.throwIfAborted()
    const memories = budgetMemories(selected.flatMap(({ memory, excerpt }) => {
      const current = this.repository.unchanged(scope, memory)
      return current && (validUntil(current) ?? Infinity) > Date.now() ? [{ ...current, content: excerpt ?? current.content }] : []
    }))
    logDiagnostic({ event: 'memory.recall.completed', ...duration(), matchCount: memories.length, result: memories.length ? 'matched' : 'no_match' })
    if (!memories.length) return ''
    return MEMORY_RECALL_HEADING +
      JSON.stringify(memories.map(memory => ({ id: memory.id, kind: memory.kind, content: memory.content, provenance: { source: typeof memory.metadata === 'object' && memory.metadata !== null && !Array.isArray(memory.metadata) ? memory.metadata.source ?? 'historical_record' : 'historical_record', verification: 'unverified_history' }, createdAt: memory.createdAt, updatedAt: memory.updatedAt })))
  }
}

function budgetMemories(selected: MemoryRecord[]): MemoryRecord[] {
  let remaining = 4000
  return selected.slice(0, 5).flatMap(memory => {
    const characters = Array.from(memory.content.replaceAll('\0', '').trim())
    if (!characters.length || remaining <= 0) return []
    const limit = Math.min(remaining, 1200)
    const content = characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('')
    remaining -= Array.from(content).length
    return [{ ...memory, content }]
  })
}
