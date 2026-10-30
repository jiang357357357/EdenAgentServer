import { rpcMethods } from '@eden/api'
import type { SharedWorkspaceService } from '../../modules/shared-workspace/index.ts'
import { contractHandler } from './contract-handler.ts'

export function sharedWorkspaceRoutes(service: SharedWorkspaceService) {
  return {
    'sharedWorkspace.posture.read': contractHandler(rpcMethods['sharedWorkspace.posture.read'], input => service.posture(input.sessionId)),
    'sharedWorkspace.posture.select': contractHandler(rpcMethods['sharedWorkspace.posture.select'], input => service.selectPosture(input.sessionId, input.mode, input.expectedRevision)),
    'sharedWorkspace.directory.read': contractHandler(rpcMethods['sharedWorkspace.directory.read'], input => service.directory(input.sessionId)),
    'sharedWorkspace.directory.select': contractHandler(rpcMethods['sharedWorkspace.directory.select'], input => service.selectDirectory(input.sessionId, input.path, input.expectedRevision)),
    'sharedWorkspace.status': contractHandler(rpcMethods['sharedWorkspace.status'], input => service.forSession(input.sessionId).status()),
    'sharedWorkspace.network': contractHandler(rpcMethods['sharedWorkspace.network'], input => service.forSession(input.sessionId).network(input.expectedWorkspacePath)),
    'sharedWorkspace.hosts': contractHandler(rpcMethods['sharedWorkspace.hosts'], input => service.forSession(input.sessionId).hosts(input.expectedWorkspacePath)),
    'sharedWorkspace.exportHost': contractHandler(rpcMethods['sharedWorkspace.exportHost'], input => service.forSession(input.sessionId).exportHost(input.expectedWorkspacePath)),
    'sharedWorkspace.sshProbe': contractHandler(rpcMethods['sharedWorkspace.sshProbe'], input => service.forSession(input.sessionId).sshProbe(input.expectedWorkspacePath, input.target)),
    'sharedWorkspace.deployHost': contractHandler(rpcMethods['sharedWorkspace.deployHost'], input => service.forSession(input.sessionId).deployHost(input.expectedWorkspacePath, input.deployment)),
    'sharedWorkspace.deploymentStatus': contractHandler(rpcMethods['sharedWorkspace.deploymentStatus'], input => service.forSession(input.sessionId).deploymentStatus(input.expectedWorkspacePath, input.jobId)),
    'sharedWorkspace.cancelDeployment': contractHandler(rpcMethods['sharedWorkspace.cancelDeployment'], input => service.forSession(input.sessionId).deploymentStatus(input.expectedWorkspacePath, input.jobId, true)),
    'sharedWorkspace.connectHost': contractHandler(rpcMethods['sharedWorkspace.connectHost'], input => service.forSession(input.sessionId).connectHost(input.expectedWorkspacePath, input.code, input.address)),
    'sharedWorkspace.invitePairing': contractHandler(rpcMethods['sharedWorkspace.invitePairing'], input => service.forSession(input.sessionId).invitePairing(input.expectedWorkspacePath, input.hostDeviceId)),
    'sharedWorkspace.pairDevice': contractHandler(rpcMethods['sharedWorkspace.pairDevice'], input => service.forSession(input.sessionId).pairDevice(input.expectedWorkspacePath, input.code, input.address)),
    'sharedWorkspace.devices': contractHandler(rpcMethods['sharedWorkspace.devices'], input => service.forSession(input.sessionId).devices(input.expectedWorkspacePath, input.hostDeviceId)),
    'sharedWorkspace.revokeDevice': contractHandler(rpcMethods['sharedWorkspace.revokeDevice'], input => service.forSession(input.sessionId).revokeDevice(input.expectedWorkspacePath, input.deviceId, input.hostDeviceId)),
    'sharedWorkspace.spaces': contractHandler(rpcMethods['sharedWorkspace.spaces'], input => service.forSession(input.sessionId).spaces(input.expectedWorkspacePath)),
    'sharedWorkspace.create': contractHandler(rpcMethods['sharedWorkspace.create'], input => service.forSession(input.sessionId).create(input.expectedWorkspacePath, input.name, input.hostDeviceId, input.sourceDirectory)),
    'sharedWorkspace.cloudDirectories': contractHandler(rpcMethods['sharedWorkspace.cloudDirectories'], input =>
      service.forSession(input.sessionId).cloudSourceRequest(input.expectedWorkspacePath, input.hostDeviceId, 'POST', 'directories/list', { path: input.path, after: input.after })),
    'sharedWorkspace.cloudDirectory.create': contractHandler(rpcMethods['sharedWorkspace.cloudDirectory.create'], input =>
      service.forSession(input.sessionId).cloudSourceRequest(input.expectedWorkspacePath, input.hostDeviceId, 'POST', 'directories/create', { parent: input.parent, name: input.name })),
    'sharedWorkspace.source.bind': contractHandler(rpcMethods['sharedWorkspace.source.bind'], input =>
      service.forSession(input.sessionId).cloudSourceRequest(input.expectedWorkspacePath, input.hostDeviceId, 'POST', `spaces/${input.spaceId}/source`, { path: input.path, confirmSource: input.confirmSource })),
    'sharedWorkspace.source.conflicts': contractHandler(rpcMethods['sharedWorkspace.source.conflicts'], input =>
      service.forSession(input.sessionId).cloudSourceRequest(input.expectedWorkspacePath, input.hostDeviceId, 'GET', `spaces/${input.spaceId}/source/conflicts`)),
    'sharedWorkspace.source.resolve': contractHandler(rpcMethods['sharedWorkspace.source.resolve'], input =>
      service.forSession(input.sessionId).cloudSourceRequest(input.expectedWorkspacePath, input.hostDeviceId, 'POST', `spaces/${input.spaceId}/source/resolve`, { conflictId: input.conflictId, strategy: input.strategy })),
    'sharedWorkspace.cloudMembers': contractHandler(rpcMethods['sharedWorkspace.cloudMembers'], input =>
      service.forSession(input.sessionId).cloudSourceRequest(input.expectedWorkspacePath, input.hostDeviceId,
        input.action === 'list' ? 'GET' : input.action === 'set' ? 'PUT' : 'DELETE', `spaces/${input.spaceId}/members`, { deviceId: input.deviceId, role: input.role })),
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
