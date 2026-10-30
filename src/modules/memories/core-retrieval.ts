import type { JsonValue, MemoryRecord } from '@eden/api'
import { z } from 'zod'
import { validUntil } from './retrieval.ts'
import type { MemoryRetrievalRequest, MemoryMatch } from './retrieval.ts'

const resultSchema = z.object({ source: z.literal('agent-local'), method: z.literal('vector_threshold'),
  threshold: z.number().finite().min(0).max(1), items: z.array(z.object({ id: z.string(), similarity: z.number().finite().min(-1).max(1), excerpt: z.string().min(1).max(800).optional() })).max(5) })

export async function coreMemoryRetrieval(input: MemoryRetrievalRequest,
  request: (sessionId: string, body: JsonValue, signal?: AbortSignal) => Promise<JsonValue>): Promise<MemoryMatch[]> {
  if (input.scope.scopeType !== 'agent_character' || !/^[1-9]\d*$/.test(input.scope.scopeKey)) throw new Error('Invalid Core memory scope')
  const candidates = input.candidates.filter(memory => (validUntil(memory) ?? Infinity) > Date.now())
  const matches: MemoryMatch[] = []
  for (const batch of batches(candidates)) {
    input.signal?.throwIfAborted()
    const result = resultSchema.parse(await request(input.sessionId, { character_id: Number(input.scope.scopeKey),
      query: Array.from(input.query).slice(-8192).join(''), documents: batch.map(memory => ({ id: String(memory.id), content: memory.content,
        ...(validUntil(memory) === undefined ? {} : { valid_until: validUntil(memory)! / 1000 }) })) }, input.signal))
    const allowed = new Set(batch.map(memory => String(memory.id)))
    for (const item of result.items) {
      if (!allowed.delete(item.id) || item.similarity < result.threshold) throw new Error('Invalid Core memory retrieval result')
      if (item.excerpt && !batch.find(memory => String(memory.id) === item.id)!.content.includes(item.excerpt)) throw new Error('Core memory excerpt changed source text')
      matches.push({ id: Number(item.id), similarity: item.similarity, ...(item.excerpt ? { excerpt: item.excerpt } : {}) })
    }
  }
  return matches.sort((left, right) => right.similarity - left.similarity || left.id - right.id).slice(0, 5)
}

function batches(candidates: MemoryRecord[]): MemoryRecord[][] {
  const result: MemoryRecord[][] = []
  let batch: MemoryRecord[] = [], bytes = 0
  for (const memory of candidates) {
    const size = Buffer.byteLength(memory.content, 'utf8')
    if (batch.length >= 128 || bytes + size > 500 * 1024) { result.push(batch); batch = []; bytes = 0 }
    batch.push(memory); bytes += size
  }
  if (batch.length) result.push(batch)
  return result
}
