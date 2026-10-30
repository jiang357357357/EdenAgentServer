import { createHash } from 'node:crypto'
import { LocalEmbedding } from '../os/index.ts'
import { memoryChunks, validUntil } from './retrieval.ts'
import type { MemoryMatch, MemoryRetrievalRequest } from './retrieval.ts'

/** The local world never borrows a Mon connection or account. */
export class LocalMemoryRetrieval {
  private readonly embedding: LocalEmbedding
  private readonly vectors = new Map<string, number[]>()
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(modelPath: string, private readonly threshold = 0.6) { this.embedding = new LocalEmbedding(modelPath) }

  retrieve(input: MemoryRetrievalRequest): Promise<MemoryMatch[]> {
    if (this.closed) return Promise.reject(new Error('Memory retrieval closed'))
    const pending = this.tail.then(() => this.score(input))
    this.tail = pending.catch(() => undefined)
    return pending
  }

  private async vector(text: string): Promise<number[]> {
    const key = createHash('sha256').update(text).digest('hex')
    const cached = this.vectors.get(key)
    if (cached) { this.vectors.delete(key); this.vectors.set(key, cached); return cached }
    const vector = await this.embedding.embed(text)
    this.vectors.set(key, vector)
    if (this.vectors.size > 4096) this.vectors.delete(this.vectors.keys().next().value!)
    return vector
  }

  private async score(input: MemoryRetrievalRequest): Promise<MemoryMatch[]> {
    input.signal?.throwIfAborted()
    const query = await this.vector(Array.from(input.query).slice(-400).join(''))
    const matches: MemoryMatch[] = []
    for (const memory of input.candidates) {
      if ((validUntil(memory) ?? Infinity) <= Date.now()) continue
      let similarity = -1, excerpt = ''
      for (const chunk of memoryChunks(memory.content)) {
        input.signal?.throwIfAborted()
        const vector = await this.vector(chunk)
        const score = query.reduce((sum, value, index) => sum + value * vector[index]!, 0)
        if (score > similarity) { similarity = score; excerpt = chunk }
      }
      if (similarity >= this.threshold) matches.push({ id: memory.id, similarity: Math.min(1, similarity), excerpt })
    }
    input.signal?.throwIfAborted()
    return matches.sort((left, right) => right.similarity - left.similarity || left.id - right.id).slice(0, 5)
  }

  async close(): Promise<void> { this.closed = true; await this.tail; this.vectors.clear(); await this.embedding.close() }
}
