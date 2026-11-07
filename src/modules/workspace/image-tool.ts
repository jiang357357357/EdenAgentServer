import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import type { WorkspaceService } from './workspace-service.ts'
import { localFile } from './local-file-target.ts'
import { readLocalImage } from './local-image.ts'

const schema = z.object({ path: z.string().min(1).max(4096) }).strict()
const imageOutput = z.object({ content: z.array(z.object({ type: z.literal('image'), data: z.string(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) })).length(1) })

export function localImageTool(workspace: WorkspaceService): RuntimeTool {
  return { name: 'read_image', revision: 'eden.files.image.v1', executionMode: 'sequential',
    description: toolDescription('read_image'),
    parameters: toJson(z.toJSONSchema(schema)) as Record<string, import('@eden/api').JsonValue>,
    async resultImages(result, signal) {
      signal.throwIfAborted()
      return imageOutput.parse(result).content
    },
    async execute(raw, context) {
      const input = schema.parse(raw)
      context.signal.throwIfAborted(); context.assertCurrent?.()
      const location = workspace.snapshot(), filename = localFile(location.root, input.path)
      const result = await readLocalImage(filename, context.signal)
      context.signal.throwIfAborted(); context.assertCurrent?.(); workspace.assertSnapshot(location)
      if (localFile(location.root, input.path) !== filename) throw new Error('图片目标在读取期间发生变化，请重新读取')
      return toJson(result)
    },
  }
}
