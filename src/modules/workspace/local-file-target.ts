import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export function localFile(root: string, requested: string): string {
  if (requested.includes('\0')) throw new Error('Invalid file path')
  return realpathSync(path.resolve(root, requested))
}

/** Resolve missing parents without creating anything before approval. */
export function localFileTarget(root: string, requested: string): string {
  if (requested.includes('\0')) throw new Error('Invalid file path')
  let existing = path.resolve(root, requested)
  const missing: string[] = []
  for (;;) {
    try {
      const canonical = realpathSync(existing)
      if (missing.length && !statSync(canonical).isDirectory()) throw new Error('File parent is not a directory')
      return path.join(canonical, ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        lstatSync(existing)
        throw new Error('File path contains a dangling symbolic link')
      } catch (missingError) {
        if ((missingError as NodeJS.ErrnoException).code !== 'ENOENT') throw missingError
      }
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      missing.unshift(path.basename(existing))
      existing = parent
    }
  }
}
