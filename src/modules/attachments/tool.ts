import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { AttachmentService } from './service.ts'
import type { AttachmentRepository } from './repository.ts'
import type { PermissionService } from '../permissions/index.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { videoFrames } from './video-frames.ts'

const parameters = z.object({
  action: z.enum(['list', 'read', 'frames']), blobId: z.uuid().optional(),
  encoding: z.enum(['text', 'base64']).default('text'),
  offset: z.number().int().min(0).max(32 * 1024 * 1024).default(0),
  limit: z.number().int().min(1).max(16384).default(8192),
}).strict()

function textPage(bytes: Buffer, offset: number, limit: number) {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('附件不是有效的 UTF-8 文本；二进制内容请使用 base64 编码读取') }
  if (offset > text.length) throw new Error('offset 超出附件文本长度')
  if (offset && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) throw new Error('offset 切分了一个 Unicode 字符')
  let end = Math.min(text.length, offset + limit)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
  if (end === offset && offset < text.length) end = Math.min(text.length, offset + 2)
  return { encoding: 'text', offsetUnit: 'utf16', content: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}

export function attachmentTool(repository: AttachmentRepository, service: AttachmentService, sessionId: string, turnId: string,
  permissions?: PermissionService): RuntimeTool {
  return {
    name: 'read_attachment', revision: 'eden.attachments.v2',
    description: toolDescription('read_attachment'),
    parameters: toJson(z.toJSONSchema(parameters, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    modelResult(result) {
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.frames)) return result
      return toJson({ blobId: result.blobId, frameCount: result.frames.length,
        timeSeconds: result.frames.map(frame => frame && typeof frame === 'object' && !Array.isArray(frame) ? frame.timeSeconds : null),
        note: '画面预览不包含音轨，长视频只覆盖前几秒。' })
    },
    async resultImages(result, signal) {
      signal.throwIfAborted()
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.frames)) return []
      return result.frames.map(frame => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.data !== 'string') throw new Error('Invalid video frame')
        return { type: 'image' as const, data: frame.data, mimeType: 'image/jpeg' }
      })
    },
    async execute(raw, context) {
      const input = parameters.parse(raw)
      context.signal.throwIfAborted()
      const snapshots = repository.current(sessionId, turnId)
      if (input.action === 'list') return toJson({ attachments: snapshots })
      if (!input.blobId) throw new Error('读取附件需要当前附件列表中的 blobId')
      const snapshot = snapshots.find(item => item.blobId === input.blobId)
      if (!snapshot) throw new Error('当前输入中不存在该附件')
      const bytes = await service.read(snapshot)
      context.signal.throwIfAborted()
      repository.current(sessionId, turnId)
      if (input.action === 'frames') {
        if (!snapshot.mime.startsWith('video/')) throw new Error('画面预览仅支持视频附件')
        if (!permissions) throw new Error('视频预览缺少本机命令审批服务')
        await permissions.request({ ...context, sessionId, turnId }, 'command.execute', 'ffmpeg',
          toJson({ action: 'video.frames', blobId: snapshot.blobId, sha256: snapshot.sha256 }))
        context.signal.throwIfAborted()
        return toJson({ blobId: snapshot.blobId, frames: await videoFrames(bytes, context.signal) })
      }
      if (input.encoding === 'text') return toJson({ blobId: snapshot.blobId, ...textPage(bytes, input.offset, input.limit) })
      if (input.offset > bytes.length) throw new Error('offset 超出附件字节长度')
      const end = Math.min(bytes.length, input.offset + input.limit)
      return { blobId: snapshot.blobId, encoding: 'base64', offsetUnit: 'bytes', content: bytes.subarray(input.offset, end).toString('base64'), nextOffset: end < bytes.length ? end : null }
    },
  }
}
