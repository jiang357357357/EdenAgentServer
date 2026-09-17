import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { WebService } from './service.ts'

const domain = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/)
const searchSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(4),
  maxResults: z.number().int().min(1).max(10).optional(),
  domains: z.array(domain).max(20).optional(),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
}).strict()
const fetchSchema = z.object({
  url: z.url().max(4096).optional(), refId: z.string().trim().min(1).max(64).optional(),
  maxChars: z.number().int().min(2_000).max(60_000).optional(),
}).strict().refine(value => Boolean(value.url) !== Boolean(value.refId), 'url 和 refId 必须且只能提供一个')
const findSchema = z.object({ refId: z.string().trim().min(1).max(64), pattern: z.string().min(1).max(500) }).strict()

export function webTools(service: WebService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [
    { name: 'web_search', revision: 'eden.web.v1', executionMode: 'parallel',
      description: '搜索实时公开网页。一次可提交至多四条查询；普通查找应只搜索一次，首轮确无相关结果时才补充一次，本轮最多两次。拿到相关来源后读取一至两个来源并作答，不为追求完美来源反复搜索。',
      parameters: schema(searchSchema),
      async execute(raw, context) {
        const input = searchSchema.parse(raw)
        const request = { ...input, maxResults: input.maxResults ?? 5, domains: input.domains ?? [] }
        await permissions.request({ ...context, sessionId, turnId }, 'network.read', 'web-search', toJson({ queries: request.queries, domains: request.domains }))
        return service.search(sessionId, request, context.signal, turnId)
      },
    },
    { name: 'web_fetch', revision: 'eden.web.v1', executionMode: 'parallel',
      description: '读取公开 HTTP/HTTPS 来源正文；可传入网址或 web_search 返回的 refId。普通查找读取一至两个直接相关来源即可；某个站点拒绝访问或正文不足时，已有来源足以支持结论就直接作答。不要抓取搜索引擎结果页。',
      parameters: fetchParameters(),
      async execute(raw, context) {
        const input = fetchSchema.parse(raw)
        await permissions.request({ ...context, sessionId, turnId }, 'network.read', input.url ?? input.refId!, toJson({ url: input.url ?? null, refId: input.refId ?? null }))
        return service.fetch(sessionId, { ...input, maxChars: input.maxChars ?? 28_000 }, context.signal, turnId)
      },
    },
    { name: 'web_find', revision: 'eden.web.v1', executionMode: 'parallel',
      description: '在 web_fetch 已读取的页面正文中查找文字并返回附近片段。',
      parameters: schema(findSchema),
      async execute(raw, context) { context.signal.throwIfAborted(); const input = findSchema.parse(raw); return service.find(sessionId, input.refId, input.pattern) },
    },
  ]
}

function schema(value: z.ZodType): Record<string, JsonValue> { return toJson(z.toJSONSchema(value)) as Record<string, JsonValue> }

function fetchParameters(): Record<string, JsonValue> {
  return { ...schema(fetchSchema), oneOf: [{ required: ['url'] }, { required: ['refId'] }] }
}
