import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SharedInstallation { entry: string | null; reason: string | null }
export function discoverSharedWorkspace(starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))],
  explicitRoot = process.env.MON_SHARED_WORKSPACE_DLC_ROOT, workspaceRoot?: string): SharedInstallation {
  const root = workspaceRoot ?? resolveRoot(starts, explicitRoot)
  if (!root) return { entry: null, reason: '未找到 Mon 工作区' }
  const source = path.join(root, 'DLC', 'SharedWorkspace')
  const directory = explicitRoot ? path.resolve(explicitRoot) : existsSync(source) ? source : path.join(path.dirname(root), 'SharedWorkspace')
  try {
    if (lstatSync(directory).isSymbolicLink())
      return { entry: null, reason: '共享资料库 DLC 目录不能使用符号链接' }
    if (!enabled(root))
      return { entry: null, reason: '共享资料库 DLC 尚未启用' }
    if (!compatible(directory))
      return { entry: null, reason: '共享资料库 DLC 不兼容' }
    const entry = path.join(directory, 'dlc-manifest.json')
    const relative = path.relative(realpathSync(directory), realpathSync(entry))
    if (relative.startsWith('..') || path.isAbsolute(relative) || !statSync(entry).isFile())
      return { entry: null, reason: '共享资料库 DLC 入口无效' }
    return { entry, reason: null }
  } catch { return { entry: null, reason: '共享资料库 DLC 未安装或配置无效' } }
}

function resolveRoot(starts: string[], explicitRoot?: string): string | undefined {
  if (process.env.MON_WORKSPACE_ROOT) return path.resolve(process.env.MON_WORKSPACE_ROOT)
  const parent = explicitRoot ? path.dirname(path.resolve(explicitRoot)) : undefined
  if (parent && path.basename(parent).toLowerCase() === 'dlc') return path.dirname(parent)
  return findRoot(starts)
}
function enabled(root: string): boolean {
  const filename = path.join(root, '.run', 'dlc', 'state.json')
  if (!existsSync(filename)) return false
  const state: unknown = JSON.parse(readFileSync(filename, 'utf8'))
  if (!state || typeof state !== 'object' || !('enabled' in state) || !state.enabled || typeof state.enabled !== 'object') return false
  return 'shared-workspace' in state.enabled && state.enabled['shared-workspace'] === true
}
function compatible(directory: string): boolean {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'dlc-manifest.json'), 'utf8')) as Record<string, unknown>
  const publisher = manifest.publisher as { capability?: unknown } | undefined
  return manifest.schemaVersion === 1 && manifest.id === 'shared-workspace' && publisher?.capability === 'workspace.publish.v2'
    && manifest.transport === 'lan' && manifest.protocolVersion === 2
    && Array.isArray(manifest.capabilities) && manifest.capabilities.includes('workspace.publish.v2')
}

function findRoot(starts: string[]): string | undefined {
  for (const start of starts) {
    let current = path.resolve(start)
    while (true) {
      if (existsSync(path.join(current, '.monworkspace')) && existsSync(path.join(current, '.monconfig'))) return current
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}
