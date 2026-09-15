import type { PluginService } from '@eden/plugin-host'

const snapshots = new WeakMap<PluginService, Map<string, Map<string, string>>>()

export function modelDraftSnapshots(plugins: PluginService, scope: string) {
  let scopes = snapshots.get(plugins)
  if (!scopes) { scopes = new Map(); snapshots.set(plugins, scopes) }
  let revisions = scopes.get(scope)
  if (!revisions) {
    revisions = new Map(); scopes.set(scope, revisions)
    if (scopes.size > 512) scopes.delete(scopes.keys().next().value!)
  }
  const saved = revisions
  return {
    read(id: string) {
      const draft = plugins.drafts.read(id)
      saved.set(id, draft.draftRevision!)
      return { manifest: draft.manifest, source: draft.source }
    },
    expected(id: string) { return saved.get(id) ?? null },
    capture(id: string) {
      const draft = plugins.drafts.read(id, saved.get(id))
      saved.set(id, draft.draftRevision!)
      return draft.draftRevision!
    },
    remember(id: string, revision: string) { saved.set(id, revision) },
  }
}
