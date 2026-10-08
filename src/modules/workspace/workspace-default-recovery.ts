import { lstatSync } from 'node:fs'
import path from 'node:path'
import type { EdenDatabase } from '@eden/store'
import { currentAccount } from '../accounts/index.ts'
import { WorkspaceLocation } from './workspace-location.ts'
import { parseWorkspaceSelection, type WorkspaceDefaultResolution, type WorkspaceSelection } from './workspace-selection.ts'

const managed: WorkspaceSelection = { version: 1, kind: 'managed', id: 'default' }
type Settings = Record<string, unknown>

/** Match the complete account-owned layout and identity, never just a "workspace" suffix. */
function accountDefaultIdentity(root: string): string | undefined {
  if (!path.isAbsolute(root) && !path.win32.isAbsolute(root)) return undefined
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/, '')
  if (normalized.split('/').some(part => part === '.' || part === '..')) return undefined
  return /(?:^|\/)Data\/(?:Agent\/)?realms\/mon\/accounts\/([a-f0-9]{64})\/workspace$/i.exec(normalized)?.[1]?.toLowerCase()
}

function missing(root: string): boolean {
  try { lstatSync(root); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}

export function legacyAccountDefault(root: string | undefined, current: string | null,
  selection: WorkspaceSelection | undefined, explicitlySelected: boolean): boolean {
  if (!root || !current || root === current || explicitlySelected || selection?.kind === 'managed') return false
  if (selection?.kind === 'external' && selection.path !== root) return false
  const account = accountDefaultIdentity(root)
  return Boolean(account && account === accountDefaultIdentity(current) && missing(root))
}

function inheritedSettings(json: string, previousRoot: string): Settings | undefined {
  try {
    const settings: unknown = JSON.parse(json)
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined
    const values = settings as Settings
    if (values['workspace.root'] !== previousRoot || values['workspace.selection.explicit']
      || values['workspace.selection.last_projection_change']) return undefined
    const selection = values['workspace.selection'] === undefined ? undefined : parseWorkspaceSelection(values['workspace.selection'])
    return selection?.kind === 'external' && selection.path !== previousRoot ? undefined : values
  } catch { return undefined }
}

/** Only untouched copies of the proven former default are eligible for relocation. */
export function recoverInheritedWorkspaces(database: EdenDatabase, previousRoot: string, currentRoot: string,
  resolution?: WorkspaceDefaultResolution): number {
  const owner = currentAccount()?.key ?? database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value ?? null
  const rows = database.connection.prepare(`SELECT w.session_id,w.settings_json FROM session_workspaces w
    JOIN sessions s ON s.id=w.session_id WHERE s.status!='deleted'
    AND (? IS NULL OR s.id IN (SELECT session_id FROM session_owners WHERE account_key=?))`).all(owner, owner)
  const update = database.connection.prepare(`UPDATE session_workspaces SET settings_json=?,revision=revision+1,updated_at=?
    WHERE session_id=? AND settings_json=?`)
  let recovered = 0
  for (const row of rows) {
    const settings = inheritedSettings(String(row.settings_json), previousRoot)
    if (!settings) continue
    const previousSelection = settings['workspace.selection'] ?? null
    settings['workspace.selection'] = managed
    settings['workspace.root'] = currentRoot
    if (resolution) settings['workspace.selection.default_resolution'] = resolution
    settings['workspace.selection.default_recovery'] = {
      version: 1, previousRoot, previousSelection, currentRoot,
      reason: 'inherited-legacy-account-default', recoveredAt: Date.now(),
    }
    recovered += Number(update.run(JSON.stringify(settings), Date.now(), String(row.session_id), String(row.settings_json)).changes)
  }
  return recovered
}

/** An unavailable external default must not poison a newly created session. */
export function seedSessionWorkspace(settings: Settings): Settings {
  const root = typeof settings['workspace.root'] === 'string' ? settings['workspace.root'] : undefined
  const selection = settings['workspace.selection'] === undefined ? undefined : parseWorkspaceSelection(settings['workspace.selection'])
  if (selection?.kind === 'managed') return settings
  const selected = selection ?? (root ? { version: 1, kind: 'external', path: root } as const : undefined)
  if (!selected || new WorkspaceLocation().info(selected, root).status === 'ready') return settings
  const seed: Settings = { 'workspace.selection.seed_recovery': { version: 1, previousRoot: root ?? null,
    previousSelection: selection ?? null, reason: 'unavailable-account-default', recoveredAt: Date.now() } }
  if (Object.hasOwn(settings, 'workspace.selection.default_resolution'))
    seed['workspace.selection.default_resolution'] = settings['workspace.selection.default_resolution']
  return seed
}
