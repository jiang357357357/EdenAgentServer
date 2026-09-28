import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { BlobService } from '../blobs/index.ts'
import type { SessionRepository } from '../sessions/session-repository.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { WorkspaceService } from '../workspace/workspace-service.ts'

const inputSchema = z.object({ path: z.string().min(1).max(4096),
  filename: z.string().min(1).max(255).optional() }).strict()
const maxBytes = 8 * 1024 * 1024

export function qqFileTool(repository: SessionRepository, blobs: BlobService,
  workspace: WorkspaceService, permissions: PermissionService,
  sessionId: string, turnId: string): RuntimeTool {
  return { name: 'send_qq_file', revision: 'eden.qq.file.v1', executionMode: 'sequential',
    description: '将当前工作区中不超过 8 MiB 的普通文件发送到本 QQ 私聊。path 为相对工作区的路径；返回已排队，QQ 发送结果由通道另行确认。',
    parameters: toJson(z.toJSONSchema(inputSchema, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = inputSchema.parse(raw)
      if (repository.read(sessionId).sourceChannel !== 'qq') throw new Error('Only QQ sessions can send QQ files')
      if (path.isAbsolute(input.path)) throw new Error('QQ file path must be relative to the workspace')
      const root = await realpath(workspace.commandRoot())
      const target = path.resolve(root, input.path)
      if (target === root || !target.startsWith(root + path.sep)) throw new Error('QQ file is outside the workspace')
      const filename = input.filename ?? path.basename(target)
      if (!filename || filename === '.' || filename === '..' || /[\x00-\x1f\x7f/\\]/.test(filename))
        throw new Error('Invalid QQ filename')
      await permissions.request({ ...context, sessionId, turnId }, 'contact.qq', 'current-qq-conversation',
        toJson({ path: input.path, filename }))
      context.signal.throwIfAborted()
      if (await realpath(target) !== target) throw new Error('QQ file path contains a symbolic link')
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try {
        if (process.platform === 'linux') {
          const openedPath = await realpath(`/proc/self/fd/${handle.fd}`)
          if (!openedPath.startsWith(root + path.sep)) throw new Error('QQ file escaped the workspace')
        }
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('QQ file must be a regular file of at most 8 MiB')
        bytes = await handle.readFile()
        if (bytes.length !== stat.size || bytes.length > maxBytes) throw new Error('QQ file changed while reading')
      } finally { await handle.close() }
      context.signal.throwIfAborted()
      const info = await blobs.put(bytes, 'application/octet-stream')
      repository.events.append(sessionId, turnId, 'qq.file_requested',
        { blobId: info.id, filename, byteLength: info.byteLength, sha256: info.sha256 })
      return { queued: true, filename, byteLength: info.byteLength }
    },
  }
}
