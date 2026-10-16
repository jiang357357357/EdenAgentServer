import path from 'node:path'
import { readWorkspacePage, writeWorkspaceFile, fileVersion, changeFile, readRecovery, restoreFile } from '../workspace/index.ts'
import { rpcMethods, toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { FileChange } from '../workspace/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { SharedWorkspaceService } from './service.ts'

type Context = Parameters<RuntimeTool['execute']>[1]
type FileInput = { path: string; content: string; expectedSha256: string | null; createOnly: boolean }

/** Only the selected, bound shared directory is resolved; ordinary workspace file tools stay unchanged. */
export class SharedLibraryFiles {
  constructor(private readonly service: SharedWorkspaceService, private readonly permissions: PermissionService,
    private readonly sessionId: string, private readonly turnId: string, private readonly scope: string,
    private readonly owner = sessionId) {}

  async read(requested: string, offset: number, limit: number, signal: AbortSignal) {
    this.relative(requested)
    const captured = await this.capture(signal)
    const hashes = captured.folder.readHashes(this.scope)
    const result = await readWorkspacePage(captured.directory.path, requested, offset, limit,
      hash => hashes.set(path.resolve(captured.directory.path, requested), hash))
    this.service.assertDirectorySnapshot(captured.directory, this.sessionId); signal.throwIfAborted()
    await captured.folder.perform(captured.directory.path, client => {
      if (client.status().spaceId !== captured.spaceId) throw new Error('共享资料库绑定在读取期间发生变化')
    })
    this.service.directory(this.sessionId)
    return toJson({ ...result, spaceId: captured.spaceId, sharedDirectory: captured.directory.path })
  }

  async write(requested: string, content: string, createOnly: boolean, context: Context) {
    this.relative(requested); this.contentSize(content)
    const captured = await this.capture(context.signal)
    const hashes = captured.folder.readHashes(this.scope), filename = path.resolve(captured.directory.path, requested)
    let expectedSha256 = hashes.get(filename) ?? null
    if (!expectedSha256) {
      try {
        await readWorkspacePage(captured.directory.path, requested, 0, 262144, hash => { expectedSha256 = hash })
        if (!expectedSha256) throw new Error('共享文件超过 1 MiB，不能安全替换')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return this.commit(captured, { path: requested, content, expectedSha256, createOnly: createOnly || expectedSha256 === null }, context)
  }

  async edit(requested: string, oldText: string, newText: string, context: Context) {
    this.relative(requested)
    const captured = await this.capture(context.signal)
    let expectedSha256: string | null = null
    const current = await readWorkspacePage(captured.directory.path, requested, 0, 1024 * 1024, hash => { expectedSha256 = hash })
    if (current.binary || current.truncated || !expectedSha256) throw new Error('编辑要求完整的 UTF-8 共享文件，最大 1 MiB')
    const previous = captured.folder.readHashes(this.scope).get(path.resolve(captured.directory.path, requested))
    if (previous && previous !== expectedSha256) throw new Error('共享文件自上次读取后已改变，请重新读取')
    const first = current.content.indexOf(oldText)
    if (first < 0 || current.content.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText 必须唯一匹配，请重新读取并缩小编辑范围')
    const content = current.content.slice(0, first) + newText + current.content.slice(first + oldText.length)
    this.contentSize(content)
    return this.commit(captured, { path: requested, content, expectedSha256, createOnly: false }, context)
  }

  async change(input: Omit<FileChange, 'expectedSha256'>, context: Context) {
    this.relative(input.path)
    if (input.destination) this.relative(input.destination)
    const captured = await this.capture(context.signal), root = captured.directory.path
    const current = await fileVersion(root, input.path)
    const previous = captured.folder.readHashes(this.scope).get(path.resolve(root, input.path))
    if (previous && previous !== current.sha256) throw new Error('共享文件自上次读取后已改变，请重新读取')
    const change = { ...input, expectedSha256: current.sha256 }
    return this.fileMutation(captured, toJson({ ...change, bytes: current.bytes.length }), context,
      () => changeFile(root, JSON.stringify([this.owner, captured.spaceId]), change, context.signal))
  }

  async restore(recoveryId: string, context: Context) {
    const captured = await this.capture(context.signal), root = captured.directory.path
    const owner = JSON.stringify([this.owner, captured.spaceId]), saved = await readRecovery(root, owner, recoveryId)
    return this.fileMutation(captured, toJson({ action: 'restore', recoveryId, path: saved.metadata.path, bytes: saved.bytes.length }), context,
      () => restoreFile(root, owner, recoveryId, context.signal))
  }

  private async fileMutation(captured: Awaited<ReturnType<SharedLibraryFiles['capture']>>, details: import('@eden/api').JsonValue,
    context: Context, work: () => Promise<import('@eden/api').JsonValue>) {
    this.service.assertDirectorySnapshot(captured.directory, this.sessionId)
    await this.writable(captured)
    const root = captured.directory.path
    await this.permissions.request({ ...context, sessionId: this.sessionId, turnId: this.turnId }, 'shared_workspace.write', root,
      toJson({ spaceId: captured.spaceId, operation: details }))
    return captured.folder.mutateFiles(root, context.signal, async () => {
      this.service.assertDirectorySnapshot(captured.directory, this.sessionId); context.signal.throwIfAborted()
      await this.writable(captured)
      return captured.folder.perform(root, async client => {
        if (client.status().spaceId !== captured.spaceId) throw new Error('共享资料库绑定在审批期间发生变化')
        const result = await work()
        return toJson({ result, spaceId: captured.spaceId, synchronized: false })
      })
    })
  }

  private async capture(signal: AbortSignal) {
    signal.throwIfAborted()
    const directory = this.service.directory(this.sessionId)
    if (directory.status !== 'ready') throw new Error(directory.error ?? '请先在共享资料库页面选择独立共享目录')
    const folder = this.service.forSession(this.sessionId), status = await folder.status()
    this.service.assertDirectorySnapshot(directory, this.sessionId); signal.throwIfAborted()
    if (!status.available || !status.bound || !status.spaceId) throw new Error(status.reason ?? '共享目录尚未绑定资料库')
    if (status.root !== directory.path) throw new Error('共享目录状态已改变，请重新查询')
    return { directory, folder, spaceId: status.spaceId }
  }

  private async writable(captured: Awaited<ReturnType<SharedLibraryFiles['capture']>>) {
    const response = rpcMethods['sharedWorkspace.spaces'].result.parse(await captured.folder.spaces(captured.directory.path))
    const space = response.spaces.find(item => item.id === captured.spaceId)
    if (!space || !['owner', 'editor'].includes(space.role)) throw new Error('当前资料库只有读取权限，不能写入共享文件')
  }

  private async commit(captured: Awaited<ReturnType<SharedLibraryFiles['capture']>>, input: FileInput, context: Context) {
    this.service.assertDirectorySnapshot(captured.directory, this.sessionId)
    await this.writable(captured)
    const root = captured.directory.path
    await this.permissions.request({ ...context, sessionId: this.sessionId, turnId: this.turnId }, 'shared_workspace.write',
      path.resolve(root, input.path), toJson({ spaceId: captured.spaceId, ...input }))
    context.signal.throwIfAborted(); this.service.assertDirectorySnapshot(captured.directory, this.sessionId)
    this.service.directory(this.sessionId)
    return captured.folder.mutateFiles(root, context.signal, async () => {
      this.service.assertDirectorySnapshot(captured.directory, this.sessionId)
      await this.writable(captured)
      this.service.directory(this.sessionId)
      return captured.folder.perform(root, async client => {
        if (client.status().spaceId !== captured.spaceId) throw new Error('共享资料库绑定在审批期间发生变化')
        const result = await writeWorkspaceFile(root, input, context.signal)
        captured.folder.readHashes(this.scope).set(path.resolve(root, input.path), (result as { sha256: string }).sha256)
        return toJson({ result, spaceId: captured.spaceId, sharedDirectory: root, synchronized: false })
      })
    })
  }

  private relative(requested: string) {
    if (path.isAbsolute(requested) || requested.includes('\0') || requested.split(/[\\/]/).includes('..')) throw new Error('共享文件必须使用资料库内的相对路径')
  }
  private contentSize(content: string) { if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('共享文件写入最多 1 MiB') }
}
