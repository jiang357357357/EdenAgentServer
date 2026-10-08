import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

export interface JsonlSinkOptions {
  filename: string
  maxBytes?: number
  backups?: number
  onFailure(error: unknown): void
}

/** Each process owns its own file; synchronous append makes close deterministic. */
export function createJsonlSink(options: JsonlSinkOptions) {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const backups = options.backups ?? 3
  let bytes = 0, disabled = false
  const failure = (error: unknown) => {
    if (disabled) return
    disabled = true
    try { options.onFailure(error) } catch { /* A failed logger must never fail the caller. */ }
  }
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(backups) || backups < 1 || backups > 20) throw new Error('Invalid log rotation limits')
    mkdirSync(path.dirname(options.filename), { recursive: true, mode: 0o700 })
    if (existsSync(options.filename)) bytes = statSync(options.filename).size
  } catch (error) { failure(error) }
  return {
    write(line: string) {
      if (disabled) return
      try {
        const size = Buffer.byteLength(line)
        if (bytes > 0 && bytes + size > maxBytes) {
          rmSync(`${options.filename}.${backups}`, { force: true })
          for (let index = backups - 1; index >= 1; index--) {
            if (existsSync(`${options.filename}.${index}`)) renameSync(`${options.filename}.${index}`, `${options.filename}.${index + 1}`)
          }
          if (existsSync(options.filename)) renameSync(options.filename, `${options.filename}.1`)
          bytes = 0
        }
        appendFileSync(options.filename, line, { encoding: 'utf8', mode: 0o600 })
        bytes += size
      } catch (error) { failure(error) }
    },
    close() { disabled = true },
  }
}
