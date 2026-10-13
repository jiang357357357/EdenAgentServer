import { runSearchProcess } from './workspace-search-process.ts'

/** Read-only search has its own process so stalled filesystem I/O cannot block the host. */
export async function searchWorkspace(root: string, requested: string, query: string, limit: number, signal: AbortSignal, expectedRoot = root) {
  return runSearchProcess({ root, expectedRoot, requested, query, limit }, signal)
}
