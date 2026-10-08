export type WorkspaceSelection =
  | { version: 1; kind: 'managed'; id: 'default' }
  | { version: 1; kind: 'external'; path: string }

export interface WorkspaceDefaultResolution { configuredPath: string; canonicalPath: string }

export function parseWorkspaceSelection(value: unknown): WorkspaceSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted workspace selection')
  const selection = value as Record<string, unknown>
  const keys = Object.keys(selection).sort().join(',')
  if (selection.version === 1 && selection.kind === 'managed' && selection.id === 'default' && keys === 'id,kind,version') {
    return { version: 1, kind: 'managed', id: 'default' }
  }
  if (selection.version === 1 && selection.kind === 'external' && typeof selection.path === 'string'
    && selection.path.length > 0 && keys === 'kind,path,version') {
    return { version: 1, kind: 'external', path: selection.path }
  }
  throw new Error('Invalid persisted workspace selection')
}
