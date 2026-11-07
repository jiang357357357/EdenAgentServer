import { componentSummary } from './manifest.ts'
import { packageRuntimeDescriptors } from './runtime-descriptors.ts'
import { packageConnectorPlans } from './connector-plan.ts'
import type { VerifiedPackage } from './verified-package.ts'

const key = (value: { capability: string; resource: string; access: string }) =>
  JSON.stringify([value.capability, value.resource, value.access])

/** Include optional declarations when an enabled runtime actually needs them. */
export function packageActivationPlan(value: VerifiedPackage, enabled: (id: string, fallback: boolean) => boolean,
  enableComponents: string[] = []) {
  const summary = componentSummary(value.manifest), wanted = new Set(enableComponents)
  if (wanted.size !== enableComponents.length || [...wanted].some(id => !summary.some(item => item.id === id)))
    throw new Error('要启用的插件组件不存在或重复')
  const selected = (id: string, fallback: boolean) => wanted.has(id) || enabled(id, fallback)
  const components = summary.map(item => ({ ...item, enabled: selected(item.id, item.enabledByDefault) }))
  const runtimes = packageRuntimeDescriptors(value, selected)
  packageConnectorPlans(value, selected)
  const needed = new Set(value.manifest.permissions.filter(item => item.required).map(key))
  for (const runtime of runtimes) {
    if (!value.manifest.permissions.some(item => key(item) === key(runtime.permission)))
      throw new Error(`后台组件 ${runtime.componentId} 未声明所需权限：${runtime.permission.capability} / ${runtime.permission.resource}`)
    needed.add(key(runtime.permission))
  }
  return { id: value.manifest.id, revision: value.revision, enableComponents: [...enableComponents], components,
    permissions: value.manifest.permissions.filter(item => needed.has(key(item))) }
}
