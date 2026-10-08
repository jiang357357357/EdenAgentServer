import { rpcMethods } from '@eden/api'
import type { SharedWorkspaceService } from '../../modules/shared-workspace/index.ts'
import { contractHandler } from './contract-handler.ts'

export function sharedWorkspaceRoutes(service: SharedWorkspaceService) {
  return {
    'sharedWorkspace.directory.read': contractHandler(rpcMethods['sharedWorkspace.directory.read'], input => service.directory(input.sessionId)),
    'sharedWorkspace.directory.select': contractHandler(rpcMethods['sharedWorkspace.directory.select'], input => service.selectDirectory(input.sessionId, input.path, input.expectedRevision)),
    'sharedWorkspace.status': contractHandler(rpcMethods['sharedWorkspace.status'], input => service.forSession(input.sessionId).status()),
    'sharedWorkspace.network': contractHandler(rpcMethods['sharedWorkspace.network'], input => service.forSession(input.sessionId).network(input.expectedWorkspacePath)),
    'sharedWorkspace.invitePairing': contractHandler(rpcMethods['sharedWorkspace.invitePairing'], input => service.forSession(input.sessionId).invitePairing(input.expectedWorkspacePath)),
    'sharedWorkspace.pairDevice': contractHandler(rpcMethods['sharedWorkspace.pairDevice'], input => service.forSession(input.sessionId).pairDevice(input.expectedWorkspacePath, input.code, input.address)),
    'sharedWorkspace.devices': contractHandler(rpcMethods['sharedWorkspace.devices'], input => service.forSession(input.sessionId).devices(input.expectedWorkspacePath)),
    'sharedWorkspace.revokeDevice': contractHandler(rpcMethods['sharedWorkspace.revokeDevice'], input => service.forSession(input.sessionId).revokeDevice(input.expectedWorkspacePath, input.deviceId)),
    'sharedWorkspace.spaces': contractHandler(rpcMethods['sharedWorkspace.spaces'], input => service.forSession(input.sessionId).spaces(input.expectedWorkspacePath)),
    'sharedWorkspace.create': contractHandler(rpcMethods['sharedWorkspace.create'], input => service.forSession(input.sessionId).create(input.expectedWorkspacePath, input.name)),
    'sharedWorkspace.bind': contractHandler(rpcMethods['sharedWorkspace.bind'], async input => {
      const scoped = service.forSession(input.sessionId)
      await scoped.bindDirectory(input.expectedWorkspacePath, input.spaceId)
      return scoped.status()
    }),
    'sharedWorkspace.sync': contractHandler(rpcMethods['sharedWorkspace.sync'], async input => {
      const scoped = service.forSession(input.sessionId)
      await scoped.perform(input.expectedWorkspacePath, client => client.sync())
      return scoped.status()
    }),
    'sharedWorkspace.pause': contractHandler(rpcMethods['sharedWorkspace.pause'], async input => {
      const scoped = service.forSession(input.sessionId)
      await scoped.perform(input.expectedWorkspacePath, client => client.pause(input.paused))
      return scoped.status()
    }),
    'sharedWorkspace.files': contractHandler(rpcMethods['sharedWorkspace.files'], input =>
      service.forSession(input.sessionId).perform(input.expectedWorkspacePath, client => ({ files: client.files() }))),
    'sharedWorkspace.conflicts': contractHandler(rpcMethods['sharedWorkspace.conflicts'], input =>
      service.forSession(input.sessionId).perform(input.expectedWorkspacePath, client => ({ conflicts: client.conflicts() }))),
    'sharedWorkspace.resolve': contractHandler(rpcMethods['sharedWorkspace.resolve'], async input => {
      const scoped = service.forSession(input.sessionId)
      await scoped.perform(input.expectedWorkspacePath, client => client.resolve(input.conflictId, input.strategy))
      return scoped.status()
    }),
    'sharedWorkspace.members': contractHandler(rpcMethods['sharedWorkspace.members'], input =>
      service.forSession(input.sessionId).members(input.expectedWorkspacePath, input.action, input.deviceId, input.role)),
    'sharedWorkspace.history': contractHandler(rpcMethods['sharedWorkspace.history'], input =>
      service.forSession(input.sessionId).perform(input.expectedWorkspacePath, client => client.history(input.fileId))),
    'sharedWorkspace.restore': contractHandler(rpcMethods['sharedWorkspace.restore'], async input => {
      const scoped = service.forSession(input.sessionId)
      await scoped.perform(input.expectedWorkspacePath, client => client.restore(input.fileId, input.revision))
      return scoped.status()
    }),
  }
}
