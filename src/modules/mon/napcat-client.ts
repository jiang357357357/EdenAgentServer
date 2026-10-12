import { z } from 'zod'
import type { MonServiceIdentity } from '@eden/integrations'
import type { SessionRepository } from '../sessions/index.ts'
import { MonConnectionRepository } from './connection-repository.ts'
import { sendNapcatRequest } from './napcat-transport.ts'
import type { NapcatResult } from './napcat-transport.ts'
import { listNapcatBots, qqBotSelection } from './napcat-bots.ts'
import type { QqBotSelection } from './napcat-bots.ts'
import { QqReferenceRepository } from './qq-reference-repository.ts'
import { QqActionResults } from './qq-action-results.ts'
import { toJson, type JsonValue } from '@eden/api'

import type { NapcatSessionTarget } from './napcat-target.ts'
export type { NapcatSessionTarget } from './napcat-target.ts'

const qqContextSchema = z.object({ session_id: z.uuid(), bot_qq: z.string().regex(/^\d{5,20}$/),
  contact_qq: z.string().regex(/^\d{5,20}$/), group_qq: z.string().regex(/^\d{5,20}$/).optional() }).strict()
const actionSchema = z.object({ description: z.string(), mutating: z.boolean(),
  target: z.string(), available: z.boolean().optional(), target_field: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).optional() }).passthrough()
const catalogSchema = z.object({ protocol: z.literal('napcat-action.v1'), actions: z.record(z.string(), actionSchema) }).passthrough()

/** QQ identity stays channel-bound; App discovery uses only the current session's verified Core connection. */
export class NapcatClient {
  private readonly connections: MonConnectionRepository | undefined
  private readonly results: QqActionResults
  constructor(private readonly sessions: SessionRepository, private readonly identity?: MonServiceIdentity,
    private readonly fetcher: typeof fetch = fetch) {
    this.connections = sessions.origin === 'mon' ? new MonConnectionRepository(sessions.database) : undefined
    this.results = new QqActionResults(new QqReferenceRepository(sessions))
  }

  modelReceipt(target: NapcatSessionTarget, result: NapcatResult): JsonValue {
    this.assertCurrent(target)
    return this.results.result(target, toJson({ ...result, ...(target.botId ? { bot_id: target.botId } : {}) }))
  }

  resolveParams(target: NapcatSessionTarget, params: Record<string, unknown>): Record<string, unknown> {
    this.assertCurrent(target)
    return this.results.params(target, params)
  }

  target(sessionId: string, botId?: string): NapcatSessionTarget {
    const session = this.sessions.read(sessionId)
    if (!this.connections) throw new Error('QQ actions require a Mon session')
    if (session.status !== 'active') throw new Error('QQ tools require an active session')
    if (session.sourceChannel === 'qq') return this.qqTarget(sessionId, botId)
    if (botId !== undefined) z.string().regex(/^[1-9]\d{0,19}$/).parse(botId)
    const connection = this.connections.read(sessionId)
    if (!connection) throw new Error('当前会话尚未连接 Core')
    return { sessionId, baseUrl: connection.coreBaseUrl, token: connection.coreToken,
      ...(botId === undefined ? { discovery: true, path: '/api/devices/qq_bot/?summary=true', resource: 'qq-bots:current-account' }
        : { botId, path: `/api/devices/qq_bot/${botId}/actions/execute/`, resource: `qq-bot:${botId}` }) }
  }

  async resolve(target: NapcatSessionTarget, signal: AbortSignal): Promise<{ target: NapcatSessionTarget } | QqBotSelection> {
    signal.throwIfAborted()
    this.assertCurrent(target)
    if (!target.discovery) return { target }
    const bots = await listNapcatBots(target, signal, this.fetcher)
    this.assertCurrent(target)
    if (bots.length !== 1) return qqBotSelection(bots)
    return { target: this.target(target.sessionId, bots[0]!.bot_id) }
  }

  assertCurrent(target: NapcatSessionTarget): void {
    const current = this.target(target.sessionId, target.botId)
    if (current.baseUrl !== target.baseUrl || current.token !== target.token || current.resource !== target.resource
      || current.path !== target.path || current.groupAllowActions !== target.groupAllowActions
      || JSON.stringify(current.qqContext) !== JSON.stringify(target.qqContext)) {
      throw new Error('当前会话的 Core 账号或 QQ 绑定已变更，请重新查询并审批目标机器人')
    }
  }

  private qqTarget(sessionId: string, botId?: string): NapcatSessionTarget {
    if (botId !== undefined) throw new Error('QQ 私聊不接受 bot_id；操作身份由当前私聊确定。')
    if (!this.identity) throw new Error('QQ service identity is unavailable')
    const group = this.sessions.database.connection.prepare(
      'SELECT session_id,bot_qq,group_qq,operator_qq AS contact_qq,allow_actions FROM qq_group_sessions WHERE session_id=?').get(sessionId)
    if (group) {
      const { allow_actions: allowActions, ...fields } = group
      const context = qqContextSchema.parse(fields)
      return { sessionId, baseUrl: this.identity.coreBaseUrl, identity: this.identity, qqContext: context,
        groupAllowActions: allowActions === 1, path: '/api/devices/qq_bot/actions/execute/',
        resource: `qq-bot:${context.bot_qq}:group:${context.group_qq}:operator:${context.contact_qq}` }
    }
    const row = this.sessions.database.connection.prepare(
      'SELECT session_id,bot_qq,contact_qq FROM qq_channel_conversations WHERE session_id=?').get(sessionId)
    const context = qqContextSchema.parse(row)
    return { sessionId, baseUrl: this.identity.coreBaseUrl, identity: this.identity, qqContext: context,
      path: '/api/devices/qq_bot/actions/execute/', resource: `qq-bot:${context.bot_qq}:contact:${context.contact_qq}` }
  }

  async capabilities(target: NapcatSessionTarget, requestId: string, signal: AbortSignal, action?: string): Promise<NapcatResult> {
    this.assertCurrent(target)
    const reply = await sendNapcatRequest(target, { action: '__capabilities__', params: action ? { action } : {}, request_id: requestId }, signal, this.fetcher)
    this.assertCurrent(target)
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

  async events(target: NapcatSessionTarget, params: Record<string, unknown>, requestId: string, signal: AbortSignal): Promise<NapcatResult> {
    this.assertCurrent(target)
    if (target.qqContext?.group_qq) throw new Error('群会话不能读取整个机器人的事件记录')
    const reply = await sendNapcatRequest(target, { action: '__events__', params, request_id: requestId }, signal, this.fetcher)
    this.assertCurrent(target)
    return reply
  }

  async execute(target: NapcatSessionTarget, action: string, params: Record<string, unknown>, mode: 'read' | 'write',
    requestId: string, signal: AbortSignal): Promise<NapcatResult> {
    const catalogReply = await this.capabilities(target, `${requestId}:schema`, signal, action)
    if (catalogReply.status !== 'success') return { ...catalogReply, action, request_id: requestId }
    const entry = catalogSchema.parse(catalogReply.result).actions[action]
    if (!entry || entry.mutating !== (mode === 'write')) throw new Error('QQ action 读写类型不匹配；请使用对应工具。')
    if (entry.available === false) throw new Error('该 QQ 能力当前不可用')
    signal.throwIfAborted()
    this.assertCurrent(target)
    const scoped = this.groupParams(target, params, mode)
    return sendNapcatRequest(target, { action, params: scoped, mode, request_id: requestId }, signal, this.fetcher)
  }

  groupParams(target: NapcatSessionTarget, params: Record<string, unknown>, mode: 'read' | 'write'): Record<string, unknown> {
    const group = target.qqContext?.group_qq
    if (!group) return params
    if (mode === 'write' && !target.groupAllowActions) throw new Error('当前群未明确启用群内修改操作')
    if (params.group_id !== undefined && String(params.group_id) !== group) throw new Error('群工具只能操作当前群')
    return { ...params, group_id: group }
  }
}
