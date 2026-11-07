import { createHash } from 'node:crypto'
import { z } from 'zod'
import { workspaceFile } from './workspace-path.ts'
import type { WorkspaceService } from './workspace-service.ts'
import type { PermissionService } from '../permissions/index.ts'
import { writeWorkspaceFile } from './workspace-write.ts'

const readSchema = z.object({ path: z.string().min(1).max(4096) }).strict()
const saveSchema = readSchema.extend({ content: z.string().max(1024 * 1024), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export interface DocumentInvocation { sessionId: string; turnId: string; callId: string; signal: AbortSignal; assertCurrent(): void; onApproved?(): void }

/** Documents share the workspace's mutation queue and compare the actual on-disk bytes before committing. */
export class ExtensionDocuments {
  constructor(private readonly workspace: WorkspaceService, private readonly permissions: PermissionService) {}
  async access(action: 'document.read' | 'document.save', raw: unknown, context: DocumentInvocation) {
    const saving = action === 'document.save' ? saveSchema.parse(raw) : undefined
    const input = saving ?? readSchema.parse(raw)
    const scoped = this.workspace.forSession(context.sessionId), location = scoped.snapshot()
    const target = workspaceFile(location.root, input.path)
    await this.permissions.request(context, saving ? 'workspace.write' : 'workspace.read', target,
      { path: target, workspaceRoot: location.root, ...(saving ? { content: saving.content, expectedSha256: saving.revision } : {}) })
    context.signal.throwIfAborted(); context.assertCurrent(); scoped.assertSnapshot(location)
    context.onApproved?.()
    if (!saving) {
      const result = await scoped.read(target)
      context.signal.throwIfAborted(); context.assertCurrent(); scoped.assertSnapshot(location)
      if (result.binary || result.truncated || !result.sha256) throw new Error('Document requires a UTF-8 file of at most 1 MiB')
      return { content: result.content, revision: result.sha256 }
    }
    if (Buffer.byteLength(saving.content) > 1024 * 1024) throw new Error('Document exceeds 1 MiB')
    return scoped.mutateFile(location, input.path, context.signal, async () => {
      context.assertCurrent()
      await writeWorkspaceFile(location.root, { path: input.path, content: saving.content, expectedSha256: saving.revision, createOnly: false }, context.signal, target)
      return { revision: createHash('sha256').update(saving.content).digest('hex') }
    }, target)
  }
}
