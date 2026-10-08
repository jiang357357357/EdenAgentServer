import { rpcMethods } from '@eden/api'
import { contractHandler } from './contract-handler.ts'
import { workspaceSwitchSchema, workspacePathSchema, sessionIdSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { WorkspaceService } from '../../modules/workspace/index.ts'
import type { SessionService } from '../../modules/sessions/index.ts'

export function workspaceRoutes(workspace: WorkspaceService, sessions: SessionService): Record<string, (value: JsonValue) => JsonValue | Promise<JsonValue>> {
  const select = (sessionId: string, change: (scoped: WorkspaceService) => ReturnType<WorkspaceService['switch']>) => {
    sessions.repository.read(sessionId)
    if (sessions.isRunning(sessionId)) throw new Error('Wait for this session’s active turn before switching its workspace')
    const scoped = workspace.forSession(sessionId)
    const changed = sessions.repository.database.transaction(() => {
      const previousPath = scoped.info().path
      const result = change(scoped)
      const event = sessions.repository.events.insert(sessionId, null, 'workspace.changed', {
        sessionID: sessionId, previousPath, path: result.currentPath,
        currentPath: result.currentPath, runtimeOrigin: sessions.repository.origin,
      })
      return { result, event }
    })
    sessions.repository.events.publish(changed.event)
    return changed.result
  }
  const handlers: Record<string, (value: JsonValue) => JsonValue | Promise<JsonValue>> = {
    'workspace.info': value => toJson(workspace.forSession(sessionIdSchema.parse(value).sessionId).info()),
    'workspace.switch': value => {
      const params = workspaceSwitchSchema.parse(value)
      return select(params.sessionId, scoped => scoped.switch(params.path))
    },
    'workspace.useDefault': value => select(sessionIdSchema.parse(value).sessionId, scoped => scoped.useDefault()),
    'workspace.list': async value => {
      const input = workspacePathSchema.parse(value)
      return toJson(await workspace.forSession(input.sessionId).list(input.path))
    },
    'workspace.read': async value => {
      const input = workspacePathSchema.parse(value)
      return toJson(await workspace.forSession(input.sessionId).read(input.path))
    },
  }
  return Object.fromEntries(Object.entries(handlers).map(([method, handler]) => {
    const contract = rpcMethods[method as keyof typeof rpcMethods]
    return [method, contractHandler(contract, input => handler(toJson(input)))]
  }))
}
