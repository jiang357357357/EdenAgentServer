import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { sharedWorkspaceUsage } from '../../model-prompts/shared-workspace.ts'
import type { SharedWorkspaceService } from './service.ts'
import { SharedWorkspaceModelQuery } from './model-query.ts'

const querySchema = z.object({ action: z.enum(['status', 'spaces', 'files']),
  query: z.string().trim().max(200).optional(), offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(), includeDeleted: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  for (const field of ['query', 'offset', 'limit', 'includeDeleted'] as const) {
    if (input[field] !== undefined && (input.action === 'status' || (field === 'includeDeleted' && input.action !== 'files')))
      context.addIssue({ code: 'custom', path: [field], message: `${field} is not supported for ${input.action}` })
  }
})

export function sharedWorkspaceTool(service: SharedWorkspaceService, sessionId: string): RuntimeTool {
  const query = new SharedWorkspaceModelQuery(service, sessionId)
  return { name: 'query_shared_workspace', revision: 'eden.shared-workspace.query.v2',
    description: toolDescription('query_shared_workspace'), promptHint: sharedWorkspaceUsage,
    parameters: toJson(z.toJSONSchema(querySchema, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = querySchema.parse(raw)
      if (input.action === 'status') return query.status(context.signal)
      const browse = { query: input.query ?? '', offset: input.offset ?? 0, limit: input.limit ?? 100 }
      if (input.action === 'spaces') return query.spaces(browse, context.signal)
      return query.files({ ...browse, includeDeleted: input.includeDeleted ?? false }, context.signal)
    },
  }
}
