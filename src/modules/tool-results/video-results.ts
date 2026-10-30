import { type ModelResult, resultObject, resultFields } from './model-fields.ts'
import type { JsonValue } from '@eden/api'

/** The engine's paths, security configuration and cache keys remain in the audit. */
export const videoResult: ModelResult = value => {
  const raw = resultObject(value)
  if (raw.isError === true) return { isError: true, error: typeof raw.error === 'string' ? raw.error : errorText(raw.content) }
  const body = raw.structuredContent ? resultObject(raw.structuredContent) : raw
  const result = resultFields(body, ['job_id', 'status', 'source', 'resolved_range', 'processing', 'warnings',
    'content', 'applied_start_ms', 'applied_end_ms', 'returned_chars', 'truncated', 'continuation_token',
    'frames', 'previews', 'healthy', 'default_model', 'installed_approved_models',
    'unavailable_approved_models', 'python', 'mcp_sdk', 'ffmpeg', 'ffprobe', 'yt_dlp', 'whisper_backend',
    'resolved_optimization_profile', 'frame_estimate', 'recommendations'])
  for (const field of ['python', 'mcp_sdk', 'ffmpeg', 'ffprobe', 'yt_dlp', 'whisper_backend']) {
    if (result[field]) result[field] = resultFields(result[field]!, ['available', 'version'])
  }
  return result
}
function errorText(content: JsonValue | undefined): string {
  if (!Array.isArray(content)) return '视频处理失败'
  return content.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string' ? [value.text] : []).join('\n').slice(0, 2000)
}
