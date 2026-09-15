import { z } from 'zod'
import { jsonValue, toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { PermissionService } from '../permissions/index.ts'
import type { ConnectorRepository } from './repository.ts'
import type { ConnectorCatalog } from './catalog.ts'
import type { ConnectorLifecycle } from './lifecycle.ts'
import { capabilityInput } from './capability-input.ts'
import { WorkerRemoteError } from './worker-channel.ts'
import { connectorCapabilityDescription } from '../../model-prompts/tool-descriptions.ts'
const inputSchema = z.object({ connectorId: z.string().uuid(), capability: z.string().min(1).max(128), payload: jsonValue.default({}) }).strict()
export function connectorCapabilityTools(database: EdenDatabase, connectors: ConnectorRepository, catalog: ConnectorCatalog,
  lifecycle: ConnectorLifecycle, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return (['query', 'execute'] as const).map(method => ({
    name: method === 'query' ? 'query_connector' : 'execute_connector', revision: 'eden.connectors.capabilities.v1', executionMode: 'sequential',
    description: connectorCapabilityDescription(method),
    parameters: toJson(z.toJSONSchema(inputSchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = inputSchema.parse(raw), current = connectors.read(input.connectorId)
      if (current.settings.boundSessionId !== sessionId) throw new Error('该连接器未绑定到当前会话')
      const descriptor = catalog.descriptor(current.connectorKey)
      const schema = descriptor.manifest[method === 'query' ? 'queries' : 'actions'][input.capability]
      if (!schema) throw new Error('连接器未声明该能力')
      const payload = toJson(capabilityInput(schema).parse(input.payload))
      if (JSON.stringify(payload).length > 65536) throw new Error('连接器能力输入超过长度限制')
      await permissions.request({ ...context, sessionId, turnId }, `connector.${method}`, `${current.id}:${input.capability}`,
        { generation: current.generation, revision: descriptor.revision, payload })
      context.signal.throwIfAborted()
      const updated = connectors.read(current.id)
      if (updated.generation !== current.generation || updated.settings.boundSessionId !== sessionId) throw new Error('连接器在审批期间发生变化，请重新提交')
      const operationId = `${turnId}:${context.callId}`, db = database.connection
      if (db.prepare('SELECT 1 FROM connector_operations WHERE id=?').get(operationId)) throw new Error('连接器操作已经存在；重试前请先检查其结果')
      db.prepare("INSERT INTO connector_operations VALUES(?,?,?,?,?,?,'running',NULL,NULL,?,?)")
        .run(operationId, current.id, sessionId, current.generation, method, JSON.stringify({ capability: input.capability, payload }), Date.now(), Date.now())
      try {
        const result = await lifecycle.invoke(current.id, current.generation, method, input.capability, payload, operationId, context.signal)
        db.prepare("UPDATE connector_operations SET state='completed',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(result), Date.now(), operationId)
        return result
      } catch (error) {
        db.prepare('UPDATE connector_operations SET state=?,error=?,updated_at=? WHERE id=?').run(error instanceof WorkerRemoteError ? 'failed' : 'unknown',
          error instanceof WorkerRemoteError ? 'Worker rejected this capability call' : 'Connector call outcome was not confirmed', Date.now(), operationId)
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }),
          { toolOutcome: error instanceof WorkerRemoteError ? 'failed' : 'unknown' })
      }
    },
  }))
}
