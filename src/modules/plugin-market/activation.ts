import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MarketService } from './service.ts'

export async function activatePluginPackage(market: MarketService, approvals: PermissionService, id: string,
  sessionId: string, turnId: string, context: Parameters<RuntimeTool['execute']>[1], enableComponents: string[] = []) {
  const plan = market.installed.activationPlan(id, enableComponents)
  await approvals.request({ ...context, sessionId, turnId }, 'plugin.package.activate', id,
    toJson({ id, revision: plan.revision, components: plan.components, permissions: plan.permissions }))
  context.signal.throwIfAborted()
  context.assertCurrent?.()
  return market.installed.applyActivation(plan)
}
