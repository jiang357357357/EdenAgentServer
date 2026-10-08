import type { EdenDatabase } from '@eden/store'
import { parseWorkspaceSelection, type WorkspaceDefaultResolution, type WorkspaceSelection } from './workspace-selection.ts'
import { SessionWorkspaceRepository } from './session-workspace-repository.ts'
import { randomUUID } from 'node:crypto'
import { legacyAccountDefault, recoverInheritedWorkspaces } from './workspace-default-recovery.ts'

export class WorkspaceRepository {
  private readonly session: SessionWorkspaceRepository | undefined
  constructor(private readonly database: EdenDatabase, sessionId?: string) {
    this.session = sessionId ? new SessionWorkspaceRepository(database, sessionId) : undefined
  }

  revision(): string { return this.session?.revision() ?? String(JSON.parse(this.setting('workspace.selection.revision') ?? '"0"')) }

  inherit(parentSessionId: string): void {
    if (!this.session) throw new Error('Workspace inheritance requires a child session')
    this.session.inherit(parentSessionId)
  }

  read(): string | undefined {
    const stored = this.setting('workspace.root')
    if (!stored) return undefined
    const value: unknown = JSON.parse(stored)
    if (typeof value !== 'string') throw new Error('Invalid persisted workspace root')
    return value
  }

  set(root: string): void {
    this.select({ version: 1, kind: 'external', path: root }, root)
  }

  selection(): WorkspaceSelection | undefined {
    const stored = this.setting('workspace.selection')
    return stored ? parseWorkspaceSelection(JSON.parse(stored)) : undefined
  }

  defaultResolution(): WorkspaceDefaultResolution | undefined {
    const stored = this.setting('workspace.selection.default_resolution')
    if (!stored) return undefined
    const value: unknown = JSON.parse(stored)
    if (!value || typeof value !== 'object' || !('configuredPath' in value) || !('canonicalPath' in value)
      || typeof value.configuredPath !== 'string' || typeof value.canonicalPath !== 'string') throw new Error('Invalid persisted default workspace resolution')
    return { configuredPath: value.configuredPath, canonicalPath: value.canonicalPath }
  }

  initialize(defaultPath: string | null, provenDefault?: string, resolution?: WorkspaceDefaultResolution): void {
    this.atomic(() => {
      const legacy = this.read(), previousSelection = this.selection()
      if (provenDefault && this.recoverDefault(legacy, defaultPath, previousSelection, resolution)) return
      if (previousSelection) return
      if (!legacy && !defaultPath) return
      const managed = !legacy || legacy === provenDefault
      const selection: WorkspaceSelection = managed ? { version: 1, kind: 'managed', id: 'default' }
        : { version: 1, kind: 'external', path: legacy! }
      this.write('workspace.selection', selection)
      if (!this.setting('workspace.selection.migration')) this.write('workspace.selection.migration', {
        version: 1, previousRoot: legacy ?? null, selection,
        reason: !legacy ? 'new-default' : managed ? 'matches-current-default' : 'unproven-legacy-origin', migratedAt: Date.now() })
      this.project(managed ? defaultPath! : legacy!)
    })
  }

  private recoverDefault(legacy: string | undefined, defaultPath: string | null,
    previousSelection: WorkspaceSelection | undefined, resolution?: WorkspaceDefaultResolution): boolean {
    if (this.session || !legacy || !defaultPath) return false
    if (!legacyAccountDefault(legacy, defaultPath, previousSelection, this.wasExplicitlySelected())) return false
    this.write('workspace.selection', { version: 1, kind: 'managed', id: 'default' })
    this.project(defaultPath, resolution)
    const recoveredSessions = recoverInheritedWorkspaces(this.database, legacy, defaultPath, resolution)
    this.write('workspace.selection.default_recovery', { version: 1, previousRoot: legacy,
      previousSelection: previousSelection ?? null, currentRoot: defaultPath, recoveredSessions,
      reason: 'verified-legacy-account-default', recoveredAt: Date.now() })
    this.write('workspace.selection.revision', String(BigInt(this.revision()) + 1n))
    return true
  }

  private wasExplicitlySelected(): boolean {
    if (this.setting('workspace.selection.explicit') || BigInt(this.revision()) > 0n) return true
    const audit = this.setting('workspace.legacy_import')
    if (!audit) return false
    try { return JSON.parse(audit)?.state === 'reselected' }
    catch { return true }
  }

  select(selection: WorkspaceSelection, root: string, resolution?: WorkspaceDefaultResolution): void {
    this.atomic(() => {
      this.write('workspace.selection', parseWorkspaceSelection(selection))
      this.write('workspace.selection.explicit', { selectionId: randomUUID(), selection, selectedAt: Date.now() })
      if (!this.session) this.write('workspace.selection.revision', String(BigInt(this.revision()) + 1n))
      this.project(root, resolution)
      if (!this.session) this.database.connection.prepare("UPDATE runtime_settings SET value_json=json_set(value_json,'$.state','reselected'),updated_at=? WHERE key='workspace.legacy_import'").run(Date.now())
    })
  }

  /** Compatibility projection for existing task ownership checks; never resolves a managed selection. */
  project(root: string, resolution?: WorkspaceDefaultResolution): void {
    this.atomic(() => {
      if (resolution) this.write('workspace.selection.default_resolution', resolution)
      const previous = this.read()
      if (previous === root) return
      if (previous !== undefined) this.write('workspace.selection.last_projection_change', { previousRoot: previous, currentRoot: root, changedAt: Date.now() })
      this.write('workspace.root', root)
    })
  }

  private write(key: string, value: unknown): void {
    if (this.session) { this.session.write(key, value); return }
    this.database.connection.prepare('INSERT OR REPLACE INTO runtime_settings VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now())
  }

  private setting(key: string): string | undefined {
    if (this.session) return this.session.read(key)
    const row = this.database.connection.prepare('SELECT value_json FROM runtime_settings WHERE key=?').get(key)
    return row ? String(row.value_json) : undefined
  }

  private atomic(operation: () => void): void {
    if (this.database.inTransaction) operation()
    else this.database.transaction(operation)
  }
}
