import type { MemoryRecord, MemoryScope } from '@eden/api'

export interface MemoryRetrievalRequest {
  sessionId: string
  scope: MemoryScope
  query: string
  candidates: readonly MemoryRecord[]
  signal?: AbortSignal | undefined
}
export interface MemoryMatch { id: number; similarity: number; excerpt?: string }
export type MemoryRetriever = (request: MemoryRetrievalRequest) => Promise<MemoryMatch[]>

export function validUntil(memory: MemoryRecord): number | undefined {
  const metadata = memory.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.validUntil === undefined) return undefined
  const value = metadata.validUntil
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

export function memoryChunks(content: string): string[] {
  const chunks: string[] = []
  const paragraphs = content.replaceAll('\0', '').split(/\r?\n+/u).flatMap(value => Array.from(value).length > 400 ? value.split(/(?<=[。！？!?])\s*/u) : [value]).filter(value => value.trim())
  for (const paragraph of paragraphs) {
    const characters = Array.from(paragraph)
    for (let start = 0; start < characters.length; start += 336) {
      chunks.push(characters.slice(start, start + 400).join(''))
      if (start + 400 >= characters.length) break
    }
  }
  return chunks
}
