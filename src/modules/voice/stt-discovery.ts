import { gsvSttDiscoverySchema } from '@eden/api'
import { z } from 'zod'
import { gsvResponse } from './gsv-client.ts'

const precisionSchema = z.enum(['float32', 'float16', 'int8'])
const capabilitySchema = z.object({
  languages: z.array(z.string().trim().min(1)).max(100),
  sizes: z.array(z.string().trim().min(1)).max(100),
  precisions: z.array(precisionSchema).max(20),
})
const responseSchema = z.object({
  supported_models: z.record(z.string().trim().min(1), capabilitySchema),
})

export async function discoverGsvStt(raw: unknown, signal: AbortSignal) {
  const { config } = gsvSttDiscoverySchema.parse(raw)
  const started = Date.now()
  const response = await gsvResponse(
    { ...config, timeoutSeconds: Math.min(config.timeoutSeconds, 12) },
    '/inference/transcribe/models/info',
    signal,
  )
  const payload = responseSchema.parse(JSON.parse(response.bytes.toString('utf8')))
  return {
    ok: true as const,
    latencyMs: Date.now() - started,
    models: Object.entries(payload.supported_models).map(([modelType, capability]) => ({ modelType, ...capability })),
  }
}
