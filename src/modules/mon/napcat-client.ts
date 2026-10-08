import { z } from 'zod'
import type { MonServiceIdentity } from '@eden/integrations'
import type { SessionRepository } from '../sessions/index.ts'
import { MonConnectionRepository } from './connection-repository.ts'
import { sendNapcatRequest } from './napcat-transport.ts'
import type { NapcatResult, NapcatTarget } from './napcat-transport.ts'

const qqContextSchema = z.object({ session_id: z.uuid(), bot_qq: z.string().regex(/^\d{5,20}$/),
  contact_qq: z.string().regex(/^\d{5,20}$/), group_qq: z.string().regex(/^\d{5,20}$/).optional() }).strict()
const actionSchema = z.object({ description: z.string(), mutating: z.boolean(),
  target: z.string(), available: z.boolean().optional(), target_field: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).optional() }).passthrough()
const catalogSchema = z.object({ protocol: z.literal('napcat-action.v1'), actions: z.record(z.string(), actionSchema) }).passthrough()

/** Resolves identity from durable channel state, never from model arguments or owner-default QQ targets. */
export class NapcatClient {
  private readonly connections: MonConnectionRepository | undefined
  constructor(private readonly sessions: SessionRepository, private readonly identity?: MonServiceIdentity,
    private readonly fetcher: typeof fetch = fetch) {
    this.connections = sessions.origin === 'mon' ? new MonConnectionRepository(sessions.database) : undefined
  }

  target(sessionId: string, botId?: string): NapcatTarget {
    const session = this.sessions.read(sessionId)
    if (!this.connections) throw new Error('QQ actions require a Mon session')
    if (session.status !== 'active') throw new Error('QQ tools require an active session')
    if (session.sourceChannel === 'qq') return this.qqTarget(sessionId, botId)
    if (!botId) throw new Error('App 会话需提供 Core 机器人数据库 ID bot_id；QQ 私聊应省略此字段。')
    z.string().regex(/^[1-9]\d{0,19}$/).parse(botId)
    const connection = this.connections.read(sessionId)
    if (!connection) throw new Error('当前会话尚未连接 Core')
    return { baseUrl: connection.coreBaseUrl, token: connection.coreToken,
      path: `/api/devices/qq_bot/${botId}/actions/execute/`, resource: `qq-bot:${botId}` }
  }

  private qqTarget(sessionId: string, botId?: string): NapcatTarget {
    if (botId !== undefined) throw new Error('QQ 私聊不接受 bot_id；操作身份由当前私聊确定。')
    if (!this.identity) throw new Error('QQ service identity is unavailable')
    const group = this.sessions.database.connection.prepare(
      'SELECT session_id,bot_qq,group_qq,operator_qq AS contact_qq,allow_actions FROM qq_group_sessions WHERE session_id=?').get(sessionId)
    if (group) {
      const { allow_actions: allowActions, ...fields } = group
      const context = qqContextSchema.parse(fields)
      return { baseUrl: this.identity.coreBaseUrl, identity: this.identity, qqContext: context,
        groupAllowActions: allowActions === 1, path: '/api/devices/qq_bot/actions/execute/',
        resource: `qq-bot:${context.bot_qq}:group:${context.group_qq}:operator:${context.contact_qq}` }
    }
    const row = this.sessions.database.connection.prepare(
      'SELECT session_id,bot_qq,contact_qq FROM qq_channel_conversations WHERE session_id=?').get(sessionId)
    const context = qqContextSchema.parse(row)
    return { baseUrl: this.identity.coreBaseUrl, identity: this.identity, qqContext: context,
      path: '/api/devices/qq_bot/actions/execute/', resource: `qq-bot:${context.bot_qq}:contact:${context.contact_qq}` }
  }

  async capabilities(target: NapcatTarget, requestId: string, signal: AbortSignal, action?: string): Promise<NapcatResult> {
    const reply = await sendNapcatRequest(target, { action: '__capabilities__', params: action ? { action } : {}, request_id: requestId }, signal, this.fetcher)
    if (reply.status !== 'success') return reply
    const catalog = catalogSchema.parse(reply.result)
    if (target.qqContext?.group_qq) {
      catalog.actions = Object.fromEntries(Object.entries(catalog.actions).filter(([, spec]) =>
        spec.target === 'group' && (!spec.mutating || target.groupAllowActions)))
      catalog.count = Object.keys(catalog.actions).length
    }
    if (!action) return { ...reply, result: catalog }
    if (!Object.hasOwn(catalog.actions, action)) throw new Error(`QQ 能力未在允许列表中：${action}`)
    if (!catalog.actions[action]?.parameters) throw new Error('QQ capability parameter schema is unavailable')
    return { ...reply, result: { protocol: catalog.protocol, actions: { [action]: catalog.actions[action] } } }
  }

  events(target: NapcatTarget, params: Record<string, unknown>, requestId: string, signal: AbortSignal): Promise<NapcatResult> {
    if (target.qqContext?.group_qq) throw new Error('群会话不能读取整个机器人的事件记录')
    return sendNapcatRequest(target, { action: '__events__', params, request_id: requestId }, signal, this.fetcher)
  }

  async execute(target: NapcatTarget, action: string, params: Record<string, unknown>, mode: 'read' | 'write',
    requestId: string, signal: AbortSignal): Promise<NapcatResult> {
    const catalogReply = await this.capabilities(target, `${requestId}:schema`, signal, action)
    if (catalogReply.status !== 'success') return { ...catalogReply, action, request_id: requestId }
    const entry = catalogSchema.parse(catalogReply.result).actions[action]
    if (!entry || entry.mutating !== (mode === 'write')) throw new Error('QQ action 读写类型不匹配；请使用对应工具。')
    if (entry.available === false) throw new Error('该 QQ 能力当前不可用')
    signal.throwIfAborted()
    const scoped = this.groupParams(target, params, mode)
    return sendNapcatRequest(target, { action, params: scoped, mode, request_id: requestId }, signal, this.fetcher)
  }

  groupParams(target: NapcatTarget, params: Record<string, unknown>, mode: 'read' | 'write'): Record<string, unknown> {
    const group = target.qqContext?.group_qq
    if (!group) return params
    if (mode === 'write' && !target.groupAllowActions) throw new Error('当前群未明确启用群内修改操作')
    if (params.group_id !== undefined && String(params.group_id) !== group) throw new Error('群工具只能操作当前群')
    return { ...params, group_id: group }
  }
}
