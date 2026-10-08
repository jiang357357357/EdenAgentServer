import { mkdirSync } from 'node:fs'

/** Workspace availability is reported by WorkspaceService; it must not prevent account recovery. */
export function prepareDefaultWorkspace(directory: string): void {
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!code || !['ENOENT', 'ENOTDIR', 'EEXIST', 'EACCES', 'EPERM', 'ELOOP'].includes(code)) throw error
  }
}
