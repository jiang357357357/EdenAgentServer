import { z } from 'zod'
import { toJson, inspectVideoSchema, prepareVideoSchema, videoJobSchema, videoTimelineSchema, videoFramesSchema, videoPreviewsSchema } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { WorkspaceService } from '../workspace/index.ts'
import { mcpResultImages } from '../mcp/index.ts'
import { videoResult } from '../tool-results/index.ts'
import { toolDescription, type BuiltinToolDescription } from '../../model-prompts/tool-descriptions.ts'
import type { VideoService } from './service.ts'
import type { VideoInputScope } from './source.ts'

type Context = Parameters<RuntimeTool['execute']>[1]
export function videoTools(service: VideoService, permissions: PermissionService, workspace: WorkspaceService, scope: VideoInputScope): RuntimeTool[] {
  const approve = async (context: Context, name: string, details: unknown, network = false) => {
    context.assertCurrent?.()
    await permissions.request({ ...context, sessionId: scope.sessionId, turnId: scope.turnId },
      network ? 'video.network' : 'video.process', name, toJson(details))
    context.signal.throwIfAborted(); context.assertCurrent?.()
  }
  const tool = (name: BuiltinToolDescription, schema: z.ZodType, execute: RuntimeTool['execute']): RuntimeTool => ({
    name, revision: 'eden.video-context.v1', executionMode: 'sequential', description: toolDescription(name),
    parameters: toJson(z.toJSONSchema(schema, { io: 'input' })) as Record<string, JsonValue>,
    modelResult: videoResult, resultImages: mcpResultImages,
    outcome: result => result && typeof result === 'object' && !Array.isArray(result) && result.isError === true ? 'failed' : 'completed',
    execute,
  })
  return [tool('inspect_video', inspectVideoSchema, async (raw, context) => {
    const input = inspectVideoSchema.parse(raw), captured = service.capture(input.source, scope, workspace)
    await approve(context, 'inspect_video', input, 'youtubeUrl' in input.source)
    return service.prepare('inspect', captured, {}, scope, workspace, context.signal, () => context.assertCurrent?.())
  }), tool('prepare_video', prepareVideoSchema, async (raw, context) => {
    const { source, language, ...input } = prepareVideoSchema.parse(raw), captured = service.capture(source, scope, workspace)
    await approve(context, 'prepare_video', raw, 'youtubeUrl' in source)
    return service.prepare('prepare', captured, { ...input, transcript: { language: language ?? 'auto' },
      images: { encoding: { format: 'jpeg', quality: 85 }, sizing: { mode: 'fit', max_width: 1280, max_height: 1280 } } },
    scope, workspace, context.signal, () => context.assertCurrent?.())
  }), ...([
    ['read_video_timeline', videoTimelineSchema], ['get_video_frames', videoFramesSchema],
    ['get_video_frame_previews', videoPreviewsSchema], ['delete_video_job', videoJobSchema],
    ['video_context_doctor', z.object({}).strict()],
  ] as const).map(([name, schema]) => tool(name, schema, async (raw, context) => {
    const input = schema.parse(raw)
    await approve(context, name, input)
    return service.call(scope, name === 'video_context_doctor' ? 'video_mcp_doctor' : name, toJson(input), context.signal)
  }))]
}
