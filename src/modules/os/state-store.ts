import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { State } from './contracts.ts'

export function readState(filename: string, fallback: State = {}): State {
  if (!existsSync(filename)) return structuredClone(fallback)
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`调度文件必须是对象：${filename}`)
  return value as State
}

/** The durable rename precedes acknowledgement; no process may manufacture delivery facts. */
export function saveState(filename: string, value: unknown): void {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.tmp-${randomUUID()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) }
  finally { closeSync(fd) }
  try { renameSync(temporary, filename) }
  finally { rmSync(temporary, { force: true }) }
}

export function pendingRequests(directory: string): { filename: string; value: State }[] {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return readdirSync(directory, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name)).map(e => {
      const filename = path.join(directory, e.name)
      return { filename, value: readState(filename) }
    })
}
