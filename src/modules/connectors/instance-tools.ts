import { z } from 'zod'
import { jsonValue, toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { ConnectorCatalog } from './catalog.ts'
import type { ConnectorRepository } from './repository.ts'
import type { ConnectorPermissions } from './permissions.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const permission = z.object({ capability: z.string(), resource: z.string(), access: z.string() }).strict()
const request = z.object({ action: z.enum(['catalog', 'list', 'create', 'update', 'status', 'authorize', 'connect', 'disconnect', 'share', 'unshare']),
  connectorId: z.string().uuid().optional(), connectorKey: z.string().min(1).max(64).optional(), identityKey: z.string().min(1).max(256).optional(),
  displayName: z.string().min(1).max(256).optional(), settings: z.record(z.string(), jsonValue).optional(), permissions: z.array(permission).max(128).optional(), targetSessionId: z.string().uuid().optional() }).strict()
type Input = z.infer<typeof request>
type Context = Parameters<RuntimeTool['execute']>[1]
type Instance = ReturnType<ConnectorRepository['read']>
const show = (value: Instance) => ({ id: value.id, key: value.connectorKey, identityKey: value.identityKey,
  name: value.displayName, desiredState: value.desiredState, runtimeState: value.runtimeState, lastError: value.lastError })

class ConnectorInstanceOperations {
  constructor(private readonly repository: ConnectorRepository, private readonly catalog: ConnectorCatalog, private readonly grants: ConnectorPermissions,
    private readonly sessions: SessionRepository, private readonly approvals: PermissionService, private readonly sessionId: string, private readonly turnId: string) {}

  private bound(id?: string) {
    if (!id) throw new Error('需要连接器实例 ID')
    const value = this.repository.read(id)
    if (value.settings.boundSessionId !== this.sessionId) throw new Error('连接器未绑定到当前会话')
    return value
  }
  private assertSession() {
    const session = this.sessions.read(this.sessionId)
    if (session.sourceChannel !== 'app' || session.purpose !== 'user_chat' || session.status !== 'active' || session.archived) throw new Error('实例管理需要当前活动的应用会话')
  }
  private status(id: string) {
    const instance = this.bound(id), snapshot = this.grants.read(id)
    return toJson({ ...show(instance), ready: snapshot.ready, worker: { available: snapshot.worker.available, error: snapshot.worker.error },
      permissions: snapshot.permissions.map(({ capability, resource, resolvedResource, access, required, description, allowed, packageAllowed }) =>
        ({ capability, resource, resolvedResource, access, required, description, allowed, packageAllowed })) })
  }
  private async authorize(input: Input, context: Context) {
    const instance = this.bound(input.connectorId), snapshot = this.grants.read(instance.id)
    const chosen = input.permissions ?? snapshot.permissions.filter(item => item.required)
    const selected = chosen.map(item => {
      const match = snapshot.permissions.find(entry => entry.capability === item.capability && entry.resource === item.resource && entry.access === item.access)
      if (!match) throw new Error('连接器没有声明所选权限')
      if (!match.packageAllowed || match.resolvedResource === null) throw new Error('请先批准包权限并配置实例资源')
      return match
    }).filter(item => !item.allowed)
    if (new Set(selected.map(item => item.key)).size !== selected.length) throw new Error('连接器权限不能重复')
    if (!selected.length) return this.status(instance.id)
    await this.approvals.request({ ...context, sessionId: this.sessionId, turnId: this.turnId }, 'connector.instance.authorize', `${instance.id}:${snapshot.generation}:${snapshot.revision}`,
      toJson({ connectorId: instance.id, name: instance.displayName, generation: snapshot.generation, revision: snapshot.revision,
        permissions: selected.map(({ capability, resource, resolvedResource, access, description }) => ({ capability, resource, resolvedResource, access, description })) }))
    context.signal.throwIfAborted(); this.assertSession(); this.bound(instance.id)
    this.grants.set({ id: instance.id, generation: snapshot.generation, revision: snapshot.revision, decisions: selected.map(item => ({ key: item.key, allowed: true })) })
    return this.status(instance.id)
  }
  private async create(input: Input, context: Context) {
    if (!input.connectorKey || !input.identityKey) throw new Error('创建实例需要连接器类型和身份名称')
    if (input.settings && 'boundSessionId' in input.settings) throw new Error('会话绑定由宿主自动设置')
    const settings = this.catalog.validate(input.connectorKey, { ...input.settings, boundSessionId: this.sessionId })
    await this.approvals.request({ ...context, sessionId: this.sessionId, turnId: this.turnId }, 'connector.instance.create', input.connectorKey,
      toJson({ connectorKey: input.connectorKey, identityKey: input.identityKey, displayName: input.displayName ?? input.identityKey, settings }))
    context.signal.throwIfAborted(); this.assertSession()
    return toJson(show(this.repository.create({ connectorKey: input.connectorKey, identityKey: input.identityKey, displayName: input.displayName ?? input.identityKey, settings, desiredState: 'disconnected' })))
  }
  private async sharing(input: Input, context: Context) {
    const instance = this.bound(input.connectorId), targetId = input.targetSessionId
    if (!targetId) throw new Error('需要目标会话 ID')
    const target = this.sessions.read(targetId)
    if (target.status !== 'active' || target.sourceChannel !== 'app' || target.purpose !== 'user_chat' || target.archived) throw new Error('目标必须是活动应用会话')
    await this.approvals.request({ ...context, sessionId: this.sessionId, turnId: this.turnId }, `connector.instance.${input.action}`, instance.id,
      toJson({ connectorId: instance.id, name: instance.displayName, targetSessionId: targetId }))
    context.signal.throwIfAborted(); this.assertSession()
    const latest = this.bound(instance.id), currentTarget = this.sessions.read(targetId)
    if (latest.generation !== instance.generation || currentTarget.status !== 'active' || currentTarget.archived || currentTarget.sourceChannel !== 'app' || currentTarget.purpose !== 'user_chat') throw new Error('审批期间实例或目标会话发生变化')
    const event = this.sessions.database.transaction(() => {
      this.repository.share(instance.id, this.sessionId, targetId, input.action === 'share')
      return this.sessions.events.insert(targetId, null, 'connector.sharing', { connectorId: instance.id, shared: input.action === 'share' })
    })
    this.sessions.events.publish(event)
    return toJson({ connectorId: instance.id, targetSessionId: targetId, shared: input.action === 'share' })
  }
  private updateSettings(input: Input, current: Instance) {
    if (input.action !== 'update' && (input.settings || input.displayName)) throw new Error('连接或断开时不能同时修改实例设置')
    if (input.settings && 'boundSessionId' in input.settings) throw new Error('不能修改会话绑定')
    const settings = input.settings ? this.catalog.validate(current.connectorKey, { ...current.settings, ...input.settings, boundSessionId: this.sessionId }) : undefined
    if (settings && current.desiredState === 'connected' && JSON.stringify(settings) !== JSON.stringify(current.settings)) throw new Error('修改设置前请先断开连接器')
    return settings
  }
  private async update(input: Input, context: Context) {
    const current = this.bound(input.connectorId), settings = this.updateSettings(input, current)
    const desiredState = input.action === 'connect' ? 'connected' : input.action === 'disconnect' ? 'disconnected' : undefined
    if (input.action === 'connect' && !this.grants.read(current.id).ready) throw new Error('连接器资源权限或 worker 尚未就绪')
    const patch: { settings?: import('@eden/api').JsonValue; desiredState?: 'connected' | 'disconnected'; displayName?: string } = {}
    if (settings) patch.settings = settings
    if (desiredState) patch.desiredState = desiredState
    if (input.action === 'update' && input.displayName) patch.displayName = input.displayName
    await this.approvals.request({ ...context, sessionId: this.sessionId, turnId: this.turnId }, `connector.instance.${input.action}`, current.id,
      toJson({ id: current.id, name: current.displayName, ...patch }))
    context.signal.throwIfAborted(); this.assertSession()
    const latest = this.bound(current.id)
    if (latest.generation !== current.generation || latest.desiredState !== current.desiredState || latest.displayName !== current.displayName) throw new Error('连接器在审批期间发生变化')
    if (input.action === 'connect' && !this.grants.read(current.id).ready) throw new Error('连接器权限在审批期间发生变化')
    return toJson(show(this.repository.update({ id: current.id, patch })))
  }
  async execute(input: Input, context: Context) {
    this.assertSession()
    if (input.action === 'catalog') return toJson({ connectors: this.catalog.list().connectors.map(({ key, name, description, settings_schema, capabilities }) =>
      ({ key, name, description, settingsSchema: settings_schema, capabilities })) })
    if (input.action === 'list') return toJson({ connectors: this.repository.list().filter(item => this.repository.accessible(item.id, this.sessionId)).map(item => ({ ...show(item), owner: item.settings.boundSessionId === this.sessionId })) })
    if (input.action === 'status') return this.status(this.bound(input.connectorId).id)
    if (input.action === 'authorize') return this.authorize(input, context)
    if (input.action === 'create') return this.create(input, context)
    if (input.action === 'share' || input.action === 'unshare') return this.sharing(input, context)
    return this.update(input, context)
  }
}
export function connectorInstanceTools(repository: ConnectorRepository, catalog: ConnectorCatalog, grants: ConnectorPermissions,
  sessions: SessionRepository, approvals: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  const operations = new ConnectorInstanceOperations(repository, catalog, grants, sessions, approvals, sessionId, turnId)
  return [{ name: 'manage_connector_instances', revision: 'eden.connector-instances.v1', executionMode: 'sequential',
    description: toolDescription('manage_connector_instances'), parameters: toJson(z.toJSONSchema(request)) as Record<string, import('@eden/api').JsonValue>,
    execute: (raw, context) => operations.execute(request.parse(raw), context) }]
}
