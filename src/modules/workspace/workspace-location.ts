import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceDefaultResolution, WorkspaceSelection } from './workspace-selection.ts'

export type WorkspaceInfo = {
  name: string
  path: string
  status: 'ready' | 'missing' | 'inaccessible' | 'invalid' | 'unselected'
  kind: 'managed' | 'external' | 'none'
  defaultPath: string | null
  error: string | null
}

type Inspection = Pick<WorkspaceInfo, 'path' | 'status' | 'error'>

function inspect(root: string, expected?: string): Inspection {
  if (!path.isAbsolute(root) || root.includes('\0')) return { path: root, status: 'invalid', error: 'Workspace path must be absolute' }
  try {
    const canonical = realpathSync(root)
    if (!statSync(canonical).isDirectory()) return { path: root, status: 'invalid', error: 'Workspace must be a directory' }
    if (expected && canonical !== expected) return { path: root, status: 'invalid', error: 'Workspace path changed; select it again' }
    accessSync(canonical, constants.R_OK | constants.X_OK)
    return { path: canonical, status: 'ready', error: null }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!code) throw error
    if (code === 'ENOENT') return { path: root, status: 'missing', error: 'Workspace directory is missing; select it again or restore the directory' }
    if (code === 'EACCES' || code === 'EPERM') return { path: root, status: 'inaccessible', error: 'Workspace directory is inaccessible; check its permissions' }
    return { path: root, status: 'invalid', error: `Workspace path is unavailable (${code}); select it again` }
  }
}

/** A managed location follows startup configuration, then retains its canonical identity for this runtime. */
export class WorkspaceLocation {
  readonly defaultPath: string | null
  private readonly initialDefault: Inspection | undefined
  private readonly expectedDefault: string | undefined

  constructor(private readonly configuredDefault?: string, previous?: WorkspaceDefaultResolution) {
    this.initialDefault = configuredDefault ? inspect(configuredDefault) : undefined
    this.defaultPath = this.initialDefault?.path ?? null
    this.expectedDefault = configuredDefault === previous?.configuredPath ? previous?.canonicalPath : this.defaultPath ?? undefined
  }

  get provenDefault(): string | undefined {
    return this.initialDefault?.status === 'ready' ? this.initialDefault.path : undefined
  }

  get resolution(): WorkspaceDefaultResolution | undefined {
    return this.configuredDefault && this.expectedDefault
      ? { configuredPath: this.configuredDefault, canonicalPath: this.expectedDefault } : undefined
  }

  info(selection: WorkspaceSelection | undefined, previousProjection?: string): WorkspaceInfo {
    let result: Inspection
    if (!selection) result = { path: '', status: 'unselected', error: null }
    else if (selection.kind === 'external') result = inspect(selection.path, selection.path)
    else if (this.configuredDefault && this.defaultPath) result = inspect(this.configuredDefault, this.expectedDefault)
    else result = { path: previousProjection ?? '', status: 'invalid', error: 'Default workspace location is not configured' }
    return { ...result, kind: selection?.kind ?? 'none', defaultPath: this.defaultPath,
      name: result.path ? path.basename(result.path) : 'No workspace selected' }
  }
}
