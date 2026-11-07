import { rpcMethods, toJson } from '@eden/api'
import type { PluginUiService } from '../../modules/plugin-ui/index.ts'
import { contractHandler } from './contract-handler.ts'

export function pluginUiRoutes(service: PluginUiService, lifetime?: AbortSignal) {
  return {
    'plugin.ui.list': contractHandler(rpcMethods['plugin.ui.list'], () => toJson(service.list())),
    'plugin.ui.read': contractHandler(rpcMethods['plugin.ui.read'], input => toJson(service.read(input))),
    'plugin.ui.call': contractHandler(rpcMethods['plugin.ui.call'], input => service.call(input, lifetime)),
    'plugin.ui.cancel': contractHandler(rpcMethods['plugin.ui.cancel'], input => service.cancel(input.requestId)),
    'plugin.ui.operation': contractHandler(rpcMethods['plugin.ui.operation'], input => service.operation(input)),
    'plugin.ui.report': contractHandler(rpcMethods['plugin.ui.report'], input => service.report(input)),
    'plugin.ui.diagnostic': contractHandler(rpcMethods['plugin.ui.diagnostic'], input => service.reportDiagnostic(input)),
  }
}
