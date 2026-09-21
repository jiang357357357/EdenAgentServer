import { z } from 'zod'

const parameters = z.object({
  temperature: z.number().min(0).max(2).nullish(), top_p: z.number().min(0).max(1).nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(), frequency_penalty: z.number().min(-2).max(2).nullish(),
  thinking_enabled: z.boolean().nullish(), thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).nullish(),
  reasoning_effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullish(),
}).passthrough()

/** Preserve Core's explicit settings; native thinking takes precedence over its legacy toggle. */
export function coreGenerationParameters(raw: unknown) {
  const input = parameters.parse(raw)
  const thinking = input.thinking ? input.thinking.type === 'enabled' : input.thinking_enabled
  const reasoning = thinking === false ? 'off' : input.reasoning_effort ?? (thinking === true ? 'high' : undefined)
  const sampling = {
    ...(input.temperature == null ? {} : { temperature: input.temperature }),
    ...(input.top_p == null ? {} : { topP: input.top_p }),
    ...(input.presence_penalty == null ? {} : { presencePenalty: input.presence_penalty }),
    ...(input.frequency_penalty == null ? {} : { frequencyPenalty: input.frequency_penalty }),
  }
  return { ...(reasoning === undefined ? {} : { reasoning }), ...(Object.keys(sampling).length ? { sampling } : {}) }
}
