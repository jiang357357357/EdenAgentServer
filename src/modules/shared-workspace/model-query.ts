import { rpcMethods, toJson } from '@eden/api'
import type { SharedWorkspaceService } from './service.ts'

export interface SharedBrowseQuery { query: string; offset: number; limit: number }
export interface SharedFilesQuery extends SharedBrowseQuery { includeDeleted: boolean }

/** Shared directory selection is account-owned and independent of the session workspace. */
export class SharedWorkspaceModelQuery {
  constructor(private readonly service: SharedWorkspaceService, private readonly sessionId: string) {}

  async status(signal: AbortSignal) {
    signal.throwIfAborted()
    const snapshot = this.service.directory(this.sessionId)
    const shared = await this.readStatus(this.service.forSession(this.sessionId), snapshot.path)
    signal.throwIfAborted(); this.service.assertDirectorySnapshot(snapshot, this.sessionId)
    return toJson({ directory: snapshot, shared })
  }

  async spaces(input: SharedBrowseQuery, signal: AbortSignal) {
    signal.throwIfAborted()
    const snapshot = this.service.directory(this.sessionId)
    const service = this.service.forSession(this.sessionId)
    const response = rpcMethods['sharedWorkspace.spaces'].result.parse(await service.spaces(snapshot.path))
    signal.throwIfAborted(); this.service.assertDirectorySnapshot(snapshot, this.sessionId)
    const matches = response.spaces.filter(space => space.name.toLowerCase().includes(input.query.toLowerCase()))
    const spaces = matches.slice(input.offset, input.offset + input.limit)
    return toJson({ sharedDirectory: snapshot.path, spaces, total: matches.length,
      nextOffset: input.offset + spaces.length < matches.length ? input.offset + spaces.length : null })
  }

  async files(input: SharedFilesQuery, signal: AbortSignal) {
    signal.throwIfAborted()
    const snapshot = this.service.directory(this.sessionId)
    const service = this.service.forSession(this.sessionId), shared = await this.readStatus(service, snapshot.path)
    signal.throwIfAborted(); this.service.assertDirectorySnapshot(snapshot, this.sessionId)
    const result = !shared.available || !shared.bound ? { shared, files: [] }
      : await service.perform(snapshot.path, client => {
        const current = client.status()
        return { shared: { ...shared, ...current }, files: current.bound ? client.files() : [] }
      })
    signal.throwIfAborted(); this.service.assertDirectorySnapshot(snapshot, this.sessionId)
    const current = this.validateStatus(result.shared, snapshot.path)
    const response = rpcMethods['sharedWorkspace.files'].result.parse(result)
    const query = input.query.toLowerCase()
    const matches = response.files.filter(file => (input.includeDeleted || !file.deleted) && file.path.toLowerCase().includes(query))
      .sort((a, b) => a.path.localeCompare(b.path) || a.fileId.localeCompare(b.fileId))
    const files = matches.slice(input.offset, input.offset + input.limit)
    return toJson({ sharedDirectory: snapshot.path, shared: current, source: 'synchronized-file-index', files, total: matches.length,
      nextOffset: input.offset + files.length < matches.length ? input.offset + files.length : null })
  }

  private async readStatus(service: SharedWorkspaceService, root: string) {
    return this.validateStatus(await service.status(), root)
  }

  private validateStatus(value: unknown, root: string) {
    const status = rpcMethods['sharedWorkspace.status'].result.parse(value)
    if (status.root !== root) throw new Error('共享目录状态已改变，请重新查询')
    return status
  }
}
