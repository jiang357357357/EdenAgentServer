import { z } from 'zod'
import { memoryKindSchema } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { completeTextIsolated as completeText } from '@eden/runtime-pi'
import type { RuntimeModel } from '@eden/runtime-pi'
import { memoryContent } from './content.ts'
import { MEMORY_EXTRACTION_PROMPT } from '../../model-prompts/memory.ts'
import type { ExtractionActionEvidence } from './extraction-evidence.ts'

const candidateSchema = z.object({ kind: memoryKindSchema, content: z.string(), confidence: z.number().min(0.85).max(1),
  basis: z.enum(['user_statement', 'confirmed_action', 'assistant_proposal']).optional(),
  sourceQuote: z.string().min(1).max(6000).optional(), action: z.enum(['set_self_awake_timer', 'write_diary']).optional() })
const extractionSchema = z.object({ memories: z.array(z.unknown()).max(64).default([]) })
export type MemoryCandidate = z.infer<typeof candidateSchema>

export function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  if (raw.length > 128 * 1024) throw new Error('Memory extraction response exceeds size limit')
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last < first) throw new Error('Memory extraction response is not a JSON object')
  const result = extractionSchema.parse(JSON.parse(raw.slice(first, last + 1)))
  const candidates: MemoryCandidate[] = []
  const seen = new Set<string>()
  for (const value of result.memories) {
    const parsed = candidateSchema.safeParse(value)
    if (!parsed.success) continue
    let content: string
    try { content = memoryContent(parsed.data.content) } catch { continue }
    if (Array.from(content).length > 4000) continue
    const key = content.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ ...parsed.data, content })
  }
  return candidates
}

export interface MemoryExtractionRequest {
  model: RuntimeModel
  userText: string
  assistantText: string
  actionEvidence?: readonly ExtractionActionEvidence[]
  signal: AbortSignal
  record(snapshot: JsonValue): Promise<void>
}

/** Produces candidates only; the owning durable workflow controls acceptance and writes. */
export async function extractMemoryCandidates(request: MemoryExtractionRequest): Promise<MemoryCandidate[]> {
  request.signal.throwIfAborted()
  if (!request.userText.trim() || !request.assistantText.trim()) return []
  const text = await completeText({
    model: request.model, systemPrompt: MEMORY_EXTRACTION_PROMPT,
    text: JSON.stringify({ userMessage: Array.from(request.userText).slice(0, 6000).join(''), assistantReply: Array.from(request.assistantText).slice(0, 6000).join(''),
      assistantReplyStatus: 'unverified_character_report', actionEvidence: request.actionEvidence ?? [] }),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]), record: request.record,
  })
  request.signal.throwIfAborted()
  return parseMemoryCandidates(text).filter(candidate => {
    if (candidate.basis === 'assistant_proposal') return false
    if (candidate.basis === 'confirmed_action') return Boolean(candidate.action && request.actionEvidence?.some(
      evidence => evidence.tool === candidate.action && evidence.confirmed))
    if (candidate.basis === 'user_statement') return Boolean(candidate.sourceQuote?.trim()
      && request.userText.includes(candidate.sourceQuote.trim()))
    // Legacy parsing remains compatible; newly extracted decisions require a traceable basis.
    return candidate.kind !== 'decision'
  })
}
