import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import { CAPABILITY_DESCRIPTIONS } from '../../model-prompts/capabilities.ts'
interface DiscoveryActions {
  discover(input: { query: string; offset: number; limit: number }): unknown
  loadTools(input: { id: string }[]): unknown
  unloadTools(ids: string[]): unknown
}

const list = z.object({ query: z.string().max(300).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(40).default(20) }).strict()
const load = z.object({ tools: z.array(z.object({ id: z.string().min(1).max(8192) }).strict()).min(1).max(32) }).strict()
const unload = z.object({ ids: z.array(z.string().min(1).max(8192)).min(1).max(32) }).strict()

export function discoveryTools(session: DiscoveryActions): RuntimeTool[] {
  return [
    { name: 'list_tools', schema: list, run: (raw: unknown) => session.discover(list.parse(raw)) },
    { name: 'load_tools', schema: load, run: (raw: unknown) => session.loadTools(load.parse(raw).tools) },
    { name: 'unload_tools', schema: unload, run: (raw: unknown) => session.unloadTools(unload.parse(raw).ids) },
  ].map(definition => ({ name: definition.name, revision: 'eden.capabilities.v1', executionMode: 'sequential',
    description: CAPABILITY_DESCRIPTIONS[definition.name as keyof typeof CAPABILITY_DESCRIPTIONS],
    parameters: toJson(z.toJSONSchema(definition.schema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) { context.signal.throwIfAborted(); return toJson(definition.run(raw)) },
  }))
}
