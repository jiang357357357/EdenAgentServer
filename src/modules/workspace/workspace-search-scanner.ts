import { open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { workspaceFile, workspaceRoot } from './workspace-path.ts'
import { SEARCH_CONTENT_LIMIT, SEARCH_ENTRY_LIMIT, SEARCH_FILE_LIMIT } from './workspace-search-contracts.ts'
import type { SearchRequest, SearchSnapshot, SearchStopReason } from './workspace-search-contracts.ts'

const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.eden-shared-backups'])
interface SearchState extends SearchSnapshot { pending: string[]; needle: string; limit: number }

function limitReason(state: SearchState): SearchStopReason | undefined {
  if (state.matches.length >= state.limit) return 'match_limit'
  if (state.scannedFiles >= SEARCH_FILE_LIMIT) return 'file_limit'
  if (state.visitedEntries >= SEARCH_ENTRY_LIMIT) return 'entry_limit'
  return undefined
}

function addMatchingLines(text: string, relative: string, state: SearchState): void {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && state.matches.length < state.limit; index++) {
    if (lines[index]!.toLocaleLowerCase().includes(state.needle)) {
      state.matches.push({ path: relative, line: index + 1, preview: lines[index]!.trim().slice(0, 300) })
    }
  }
}

async function searchFileContents(filename: string, relative: string, state: SearchState,
  report: (value: SearchSnapshot) => Promise<void>): Promise<void> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
  if (!file) { state.skippedFiles++; return }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > SEARCH_CONTENT_LIMIT) { state.skippedFiles++; return }
    const bytes = Buffer.alloc(stat.size)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytes.subarray(0, bytesRead).includes(0)) { state.skippedFiles++; return }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    addMatchingLines(text, relative, state)
  } catch { state.skippedFiles++ }
  finally {
    // Even a stalled close must not discard matches already found in this file.
    try { await report(snapshot(state)) }
    finally { await file.close() }
  }
}

async function searchEntry(root: string, directory: string, entry: Dirent, state: SearchState,
  report: (value: SearchSnapshot) => Promise<void>): Promise<void> {
  const filename = path.join(directory, entry.name)
  if (entry.isDirectory()) {
    if (!skipped.has(entry.name)) state.pending.push(filename)
    return
  }
  if (!entry.isFile()) return
  state.scannedFiles++
  const relative = path.relative(root, filename)
  if (relative.toLocaleLowerCase().includes(state.needle)) {
    state.matches.push({ path: relative, line: null, preview: entry.name.slice(0, 300) })
    return
  }
  // Count attempted files and persist previous matches before a read that may never resolve.
  await report(snapshot(state))
  await searchFileContents(filename, relative, state, report)
}

function snapshot(state: SearchState): SearchSnapshot {
  return { matches: [...state.matches], scannedFiles: state.scannedFiles,
    visitedEntries: state.visitedEntries, skippedFiles: state.skippedFiles }
}

export async function scanWorkspace(request: SearchRequest, report: (value: SearchSnapshot) => Promise<void>) {
  // Canonical path checks run in the worker too: realpath itself can stall on a network drive.
  const root = workspaceRoot(request.root, [])
  if (root !== (request.expectedRoot ?? request.root)) throw new Error('Workspace path changed; select it again')
  const start = workspaceFile(root, request.requested)
  const state: SearchState = { pending: [start], matches: [], scannedFiles: 0, visitedEntries: 0, skippedFiles: 0,
    needle: request.query.toLocaleLowerCase(), limit: request.limit }
  while (state.pending.length && !limitReason(state)) {
    const directory = state.pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (limitReason(state)) break
      state.visitedEntries++
      await searchEntry(root, directory, entry, state, report)
      await report(snapshot(state))
    }
  }
  return { snapshot: snapshot(state), stopReason: limitReason(state) ?? 'completed' }
}
