import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MarketService } from './service.ts'

const request = z.object({ action: z.enum(['describe', 'inspect', 'install', 'enable', 'disable', 'list']), args: z.record(z.string(), z.unknown()) }).strict()
const identity = z.object({ id: z.string().min(1).max(128) }).strict()

export function connectorPluginTools(market: MarketService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'eden_connector_plugin', revision: 'eden.connector-plugin.v1', executionMode: 'sequential',
    description: 'Develop and install connector components using the unified plugin registry. describe gives the TS SDK, package format, build/test workflow. inspect snapshots a built package; install consumes that exact preview and leaves it disabled. enable requires existing user-authorized version permissions. This tool cannot grant permissions or read credentials.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['describe', 'inspect', 'install', 'enable', 'disable', 'list'] }, args: { type: 'object' } }, required: ['action', 'args'], additionalProperties: false },
    async execute(raw, context) {
      const input = request.parse(raw)
      if (input.action === 'describe') return describeConnectorPlugin()
      if (input.action === 'list') return toJson(market.installed.list())
      await permissions.request({ ...context, sessionId, turnId }, `plugin.connector.${input.action}`, 'plugin-registry', toJson(input.args))
      context.signal.throwIfAborted()
      if (input.action === 'inspect') return toJson(await market.inspectLocal(z.object({ path: z.string().min(1).max(4096) }).strict().parse(input.args).path))
      if (input.action === 'install') {
        const { previewID } = z.object({ previewID: z.string().uuid() }).strict().parse(input.args)
        const preview = market.previews.read(previewID)
        if (!preview.manifest.components.runtimes.some(item => item.kind === 'connector')) throw new Error('Package has no TS connector component')
        return toJson(market.installed.install(preview, true, false))
      }
      const { id } = identity.parse(input.args)
      return toJson(input.action === 'enable' ? market.installed.enable(id) : market.installed.disable(id))
    }
  }]
}
function describeConnectorPlugin() {
  return {
    sdk: '@eden/plugin-sdk/connector: ConnectorDefinition, runConnector, ConnectorContext, bridgeHttp, followLog',
    source: 'src/main.ts imports runConnector and calls await runConnector(definition). Definition includes id, version, events, queries, actions, initialize(context); return health(), query(call), execute(call), close().',
    package: 'package/plugin.json: schemaVersion=1, id/name/description/version, components.runtimes=[{id,kind:"connector",manifest:"connector.json"}], permissions. package/connector.json: runtime="node", entrypoints.node={path:"worker/main.mjs",args:[]}, id/name/description/icon/version, settingsSchema, permissions, events/queries/actions.',
    build: 'Use the approved workspace command tool: node Script/Project/package_connector.mjs --source <source-root> <built-package-root>. Bundle all dependencies; runtime cannot install npm packages.',
    test: 'Write node:test cases using WorkerFrameReader/encodeWorkerFrame and the host process runner. Test initialize/health/query/execute/event/shutdown, partial frames, wrong identity, cancellation and denied resources. Use temporary fixtures; never user Data. Tests and command execution require their normal permissions.',
    workflow: 'Write source and manifests; build; test the built worker in isolation; inspect({path:built-package-root}); install({previewID}); user approves version permissions in plugin settings; enable({id}); connector component becomes discoverable. Configure an instance and approve its resolved resources separately.',
    permissions: 'Declare every connector permission also in plugin.json. filesystem.read/write resources must reference settings.<field>; host resolves approved settings to absolute host paths; workers run with OS account access. network is a fixed endpoint bridge declared in connector.json. Identity uses environment.read connector.identityCredential. Provider credentials are not automatically inherited. Permission grants are never available to generated code.',
    limits: '32 queued requests, 8 MiB frames, bounded event buffers, immutable versioned package snapshots, isolated Node process, no network without approved bridge. A cancelled action may have an unknown remote outcome.'
  }
}
