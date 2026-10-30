import { z } from 'zod'
import { osToolDescriptions } from '../../model-prompts/os-tools.ts'
import { RecallService } from './recall.ts'
import { SemanticMemos } from './semantic-memos.ts'
import { OsMusic, musicPlatforms } from './music.ts'
import { OsCoreClient } from './core-client.ts'
import type { OsConfig, State } from './contracts.ts'

const text = z.string().max(1024 * 1024), name = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_.-]+$/)
const metadata = z.record(z.string(), z.unknown()), taskId = z.number().int().positive()
const memoFields = { title: text, description: text, due_at: text.nullable(), priority: text, intent: text,
  context: z.unknown(), metadata }
export const osToolSchemas: Record<string, z.ZodObject<any>> = {
  recall_search: z.object({ query_text: text, collection_name: name, top_k: z.number().int().min(1).max(10000).default(3) }),
  recall_add_memory: z.object({ collection_name: name, doc_id: text.min(1), content: text, metadata: metadata.nullable().optional() }),
  recall_add_memories: z.object({ collection_name: name, items: z.array(z.array(z.unknown())).max(10000) }),
  recall_delete_memories: z.object({ collection_name: name, where: metadata.nullable().optional() }),
  memo_create: z.object({ ...memoFields, description: text.default(''), due_at: text.nullable().optional(), priority: text.default('normal'),
    intent: text.default('memo'), context: z.unknown().optional(), metadata: metadata.optional() }),
  memo_update: z.object({ task_id: taskId, ...Object.fromEntries(Object.entries(memoFields).map(([key, value]) => [key, value.optional()])), progress: z.number().optional() }),
  memo_complete: z.object({ task_id: taskId }), memo_delete: z.object({ task_id: taskId }),
  memo_list: z.object({ status: text.nullable().default('active'), due_before: text.nullable().optional(), limit: z.number().int().min(1).max(500).default(50), offset: z.number().int().nonnegative().default(0) }),
  search_music: z.object({ query: text, page: z.number().int().default(1), platform: text.default('all') }), list_music_platforms: z.object({}),
  play_music: z.object({ url: text, platform: text.default('unknown'), title: text.nullable().optional(), artist: text.nullable().optional() }),
  email_status: z.object({}), email_send: z.object({ subject: text, content: text, to: z.array(text).nullable().optional(), html: text.default('') }),
}

export class OsTools {
  readonly recall: RecallService
  readonly core: OsCoreClient
  private readonly memos: SemanticMemos
  private readonly music = new OsMusic()
  private closed = false
  calls = 0
  failures = 0
  constructor(config: OsConfig) {
    this.recall = new RecallService(config); this.core = new OsCoreClient(config.identity); this.memos = new SemanticMemos(config.databasePath)
  }
  list() {
    return Object.entries(osToolSchemas).map(([name, schema]) => ({ name, description: osToolDescriptions[name]!,
      inputSchema: z.toJSONSchema(schema, { unrepresentable: 'any' }) }))
  }
  async call(name: string, raw: unknown): Promise<State> {
    this.calls++
    try {
      if (this.closed) throw new Error('本地能力服务已停止')
      const schema = osToolSchemas[name]
      if (!schema) throw new Error('本地工具不存在')
      const input = schema.parse(raw ?? {}) as State
      if (name.startsWith('recall_')) return { success: true, data: await this.recall.call(name, input) }
      return await this.execute(name, input)
    } catch (error) { this.failures++; return { success: false, error: error instanceof Error ? error.message : '本地能力调用失败' } }
  }
  private async execute(name: string, input: State): Promise<State> {
    switch (name) {
      case 'memo_create': return { success: true, data: this.memos.public(this.memos.create(input)) }
      case 'memo_update': return { success: true, data: this.memos.public(this.memos.update(input.task_id, input)) }
      case 'memo_complete': return { success: true, data: this.memos.public(this.memos.complete(input.task_id)) }
      case 'memo_delete': return { success: true, data: { deleted: this.memos.delete(input.task_id) } }
      case 'memo_list': return { success: true, data: this.memos.list(input).map(value => this.memos.public(value)) }
      case 'list_music_platforms': return { success: true, data: musicPlatforms }
      case 'search_music': return { success: true, data: await this.music.search(input.query, input.page, input.platform) }
      case 'play_music': return { success: true, data: input, message: `正在为用户播放: ${input.title ? [input.title, input.artist].filter(Boolean).join(' - ') : input.url}` }
      case 'email_status': return { success: true, data: await this.core.request('GET', '/api/agent/external-email/status/') }
      case 'email_send': return { success: true, data: await this.core.request('POST', '/api/agent/external-email/send/', input), message: `外部邮件已发送给 ${(input.to ?? []).join(', ')}` }
      default: throw new Error('本地工具不存在')
    }
  }
  async close() { this.closed = true; this.music.close(); this.core.close(); await this.recall.close(); this.memos.close() }
}
