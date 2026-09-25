import { open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { workspaceFile } from './workspace-path.ts'

const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next'])

export async function searchWorkspace(root: string, requested: string, query: string, limit: number, signal: AbortSignal) {
  const start = workspaceFile(root, requested)
  const pending = [start]
  const matches: Array<{ path: string; line: number | null; preview: string }> = []
  let scanned = 0
  let visited = 0
  const deadline = Date.now() + 15000
  const needle = query.toLocaleLowerCase()
  while (pending.length && matches.length < limit && visited < 10000 && scanned < 2000 && Date.now() < deadline) {
    signal.throwIfAborted()
    const directory = pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      signal.throwIfAborted()
      if (++visited > 10000 || matches.length >= limit || scanned >= 2000 || Date.now() >= deadline) break
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (!skipped.has(entry.name)) pending.push(filename); continue }
      if (!entry.isFile()) continue
      scanned++
      const relative = path.relative(root, filename)
      if (relative.toLocaleLowerCase().includes(needle)) {
        matches.push({ path: relative, line: null, preview: entry.name })
        continue
      }
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
      if (!file) continue
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 512 * 1024) continue
        const bytes = Buffer.alloc(stat.size)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        if (bytes.subarray(0, bytesRead).includes(0)) continue
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length && matches.length < limit; index++) {
          if (lines[index]!.toLocaleLowerCase().includes(needle)) matches.push({ path: relative, line: index + 1, preview: lines[index]!.trim().slice(0, 300) })
        }
      } catch { /* Unreadable and binary files are skipped; other files remain searchable. */ }
      finally { await file.close() }
    }
  }
  return { matches, scannedFiles: scanned, truncated: Boolean(pending.length || visited >= 10000 || scanned >= 2000 || matches.length >= limit || Date.now() >= deadline) }
}
