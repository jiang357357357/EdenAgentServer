import { open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { workspaceFile } from './workspace-path.ts'

const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next'])

interface SearchState {
  pending: string[]
  matches: Array<{ path: string; line: number | null; preview: string }>
  scanned: number
  visited: number
  deadline: number
  needle: string
  limit: number
}

function contentLimitReached(state: SearchState): boolean {
  return state.matches.length >= state.limit || state.scanned >= 2000 || Date.now() >= state.deadline
}

function addMatchingLines(text: string, relative: string, state: SearchState): void {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && state.matches.length < state.limit; index++) {
    if (lines[index]!.toLocaleLowerCase().includes(state.needle)) {
      state.matches.push({ path: relative, line: index + 1, preview: lines[index]!.trim().slice(0, 300) })
    }
  }
}

async function searchFileContents(filename: string, relative: string, state: SearchState): Promise<void> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
  if (!file) return
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 512 * 1024) return
    const bytes = Buffer.alloc(stat.size)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytes.subarray(0, bytesRead).includes(0)) return
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    addMatchingLines(text, relative, state)
  } catch { /* Unreadable and binary files are skipped; other files remain searchable. */ }
  finally { await file.close() }
}

async function searchEntry(root: string, directory: string, entry: Dirent, state: SearchState): Promise<void> {
  const filename = path.join(directory, entry.name)
  if (entry.isDirectory()) {
    if (!skipped.has(entry.name)) state.pending.push(filename)
    return
  }
  if (!entry.isFile()) return
  state.scanned++
  const relative = path.relative(root, filename)
  if (relative.toLocaleLowerCase().includes(state.needle)) {
    state.matches.push({ path: relative, line: null, preview: entry.name })
    return
  }
  await searchFileContents(filename, relative, state)
}

async function searchDirectory(root: string, directory: string, state: SearchState, signal: AbortSignal): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    signal.throwIfAborted()
    if (++state.visited > 10000 || contentLimitReached(state)) break
    await searchEntry(root, directory, entry, state)
  }
}

export async function searchWorkspace(root: string, requested: string, query: string, limit: number, signal: AbortSignal) {
  const start = workspaceFile(root, requested)
  const state: SearchState = { pending: [start], matches: [], scanned: 0, visited: 0,
    deadline: Date.now() + 15000, needle: query.toLocaleLowerCase(), limit }
  while (state.pending.length && state.visited < 10000 && !contentLimitReached(state)) {
    signal.throwIfAborted()
    await searchDirectory(root, state.pending.pop()!, state, signal)
  }
  return { matches: state.matches, scannedFiles: state.scanned,
    truncated: Boolean(state.pending.length || state.visited >= 10000 || contentLimitReached(state)) }
}
