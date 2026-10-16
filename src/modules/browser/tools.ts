import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { BrowserService } from './service.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const input = z.object({ url: z.string().url().max(4096), selector: z.string().min(1).max(512).optional(),
  screenshot: z.boolean().default(true), waitMs: z.number().int().min(0).max(5000).default(500) }).strict()

export function browserTools(browser: BrowserService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'browser_inspect', revision: 'eden.browser.inspect.v1', executionMode: 'sequential',
    description: toolDescription('browser_inspect'),
    parameters: toJson(z.toJSONSchema(input, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    resultImages: result => browser.images(result),
    async execute(raw, context) {
      const params = input.parse(raw), url = new URL(params.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许不含凭据的 HTTP(S) 页面地址')
      await permissions.request({ ...context, sessionId, turnId }, 'browser.inspect', params.url, toJson(params))
      return toJson(await browser.inspect(params, context.signal))
    },
  }]
}
