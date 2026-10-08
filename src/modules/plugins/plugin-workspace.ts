import type { PluginService } from '@eden/plugin-host'
import type { WorkspaceService, WorkspaceSnapshot } from '../workspace/index.ts'
import { pluginActivationSchema, pluginInvokeSchema, type JsonValue } from '@eden/api'

export function pluginWorkspaceSnapshot(workspace: WorkspaceService) { return workspace.snapshot(true) }

/** Existing plugin grants never authorize a different session's selected directory implicitly. */
export function assertPluginWorkspace(plugins: PluginService, id: string, revision: string, root: string): void {
  const active = plugins.activations.list().find(item => item.id === id && item.revision === revision)
  if (!active) throw new Error('Plugin revision is not active')
  if (active.readRoot && active.readRoot !== root)
    throw new Error('Plugin workspace grant belongs to another directory; explicitly authorize this session workspace before invoking it')
}

export function capturePluginActionWorkspace(plugins: PluginService, workspace: WorkspaceService | undefined, action: string, args: JsonValue) {
  if (!workspace || (action !== 'invoke' && action !== 'activate')) return undefined
  const snapshot = workspace.snapshot(true)
  assertPluginActionWorkspace(plugins, workspace, action, args, snapshot)
  return snapshot
}

export function assertPluginActionWorkspace(plugins: PluginService, workspace: WorkspaceService | undefined,
  action: string, args: JsonValue, snapshot: WorkspaceSnapshot | undefined): void {
  if (!workspace || !snapshot) return
  workspace.assertSnapshot(snapshot, true)
  if (action === 'invoke') {
    const value = pluginInvokeSchema.parse(args)
    assertPluginWorkspace(plugins, value.id, value.revision, snapshot.root)
  } else if (action === 'activate') {
    const value = pluginActivationSchema.parse(args)
    if (value.readRoot && value.readRoot !== snapshot.root) throw new Error('Plugin activation belongs to another session workspace')
  }
}
