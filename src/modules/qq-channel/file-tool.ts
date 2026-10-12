import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { BlobService } from '../blobs/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { WorkspaceService } from '../workspace/index.ts'
import type { MonBindingService } from '../mon/index.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { readQqWorkspaceFile } from './workspace-file.ts'
import { qqModelResult } from '../tool-results/index.ts'

const inputSchema = z.object({ path: z.string().min(1).max(4096),
  filename: z.string().min(1).max(255).optional() }).strict()

function qqFilename(target: string, requested?: string) {
  const filename = requested ?? path.basename(target)
  if (!filename || filename === '.' || filename === '..' || /[\x00-\x1f\x7f/\\]/.test(filename))
    throw new Error('Invalid QQ filename')
  return filename
}

export function qqFileTool(repository: SessionRepository, blobs: BlobService,
  workspace: WorkspaceService, permissions: PermissionService,
  sessionId: string, turnId: string, mon?: Pick<MonBindingService, 'ownerQqFileTarget' | 'sendOwnerQqFile'>): RuntimeTool {
  return { name: 'send_qq_file', revision: 'eden.qq.file.v1', executionMode: 'sequential',
    description: toolDescription('send_qq_file'), modelResult: qqModelResult,
    parameters: toJson(z.toJSONSchema(inputSchema, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = inputSchema.parse(raw)
      const inQq = repository.read(sessionId).sourceChannel === 'qq'
      if (!inQq && !mon) throw new Error('Mon Core must be connected before sending QQ files from this session')
      if (path.isAbsolute(input.path)) throw new Error('QQ file path must be relative to the workspace')
      const location = workspace.snapshot(true)
      const root = await realpath(location.root)
      const target = path.resolve(root, input.path)
      if (target === root || !target.startsWith(root + path.sep)) throw new Error('QQ file is outside the workspace')
      const filename = qqFilename(target, input.filename)
      const recipient = inQq ? undefined : await mon!.ownerQqFileTarget(sessionId, context.signal)
      await permissions.request({ ...context, sessionId, turnId }, 'contact.qq', inQq ? 'current-qq-conversation' : 'owner-default-qq-file',
        toJson({ path: input.path, filename, workspaceRoot: root, ...(recipient ? { botId: recipient.bot, recipientQq: recipient.number } : {}) }))
      context.signal.throwIfAborted()
      if (await realpath(workspace.commandRoot()) !== root) throw new Error('Workspace changed after QQ file permission request')
      workspace.assertSnapshot(location, true)
      const bytes = await readQqWorkspaceFile(root, target)
      context.signal.throwIfAborted()
      if (recipient) return mon!.sendOwnerQqFile(sessionId, { target: recipient, filename, bytes,
        requestId: `${turnId}:${context.callId}` }, context.signal)
      const info = await blobs.put(bytes, 'application/octet-stream')
      repository.events.append(sessionId, turnId, 'qq.file_requested',
        { blobId: info.id, filename, byteLength: info.byteLength, sha256: info.sha256 })
      return { queued: true, filename, byteLength: info.byteLength }
    },
  }
}
