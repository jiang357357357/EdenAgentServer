import { z } from 'zod'

export const SEARCH_BUDGET_MS = 120_000
export const SEARCH_CLEANUP_MS = 1_000
export const SEARCH_FILE_LIMIT = 2_000
export const SEARCH_ENTRY_LIMIT = 10_000
export const SEARCH_CONTENT_LIMIT = 512 * 1024

export const searchRequest = z.object({
  root: z.string().min(1).max(4096), expectedRoot: z.string().min(1).max(4096).optional(), requested: z.string().max(4096),
  query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50),
}).strict()
export const searchStopReason = z.enum(['completed', 'match_limit', 'file_limit', 'entry_limit', 'timeout'])
const match = z.object({ path: z.string().max(4096), line: z.number().int().positive().nullable(), preview: z.string().max(300) }).strict()
export const searchSnapshot = z.object({ matches: z.array(match).max(50),
  scannedFiles: z.number().int().min(0).max(SEARCH_FILE_LIMIT),
  visitedEntries: z.number().int().min(0).max(SEARCH_ENTRY_LIMIT),
  skippedFiles: z.number().int().min(0).max(SEARCH_FILE_LIMIT),
}).strict()
export const searchMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), snapshot: searchSnapshot }).strict(),
  z.object({ type: z.literal('done'), snapshot: searchSnapshot, stopReason: searchStopReason }).strict(),
  z.object({ type: z.literal('error'), error: z.string().max(4096) }).strict(),
])
export type SearchRequest = z.infer<typeof searchRequest>
export type SearchSnapshot = z.infer<typeof searchSnapshot>
export type SearchMessage = z.infer<typeof searchMessage>
export type SearchStopReason = z.infer<typeof searchStopReason>
export interface SearchResult extends SearchSnapshot {
  truncated: boolean
  stopReason: SearchStopReason
  elapsedMs: number
  budgetMs: number
  workerStopped: boolean
}
