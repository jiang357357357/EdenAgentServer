import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Installation identity is independent of accounts, sessions and runtime realms. */
export function workspaceIdentity(env: NodeJS.ProcessEnv, cwd: string) {
  const explicit = env.MON_WORKSPACE_ROOT?.trim()
  let root = path.resolve(explicit || cwd)
  while (!existsSync(path.join(root, '.monconfig')) || !existsSync(path.join(root, '.monworkspace'))) {
    if (explicit) throw new Error('MON_WORKSPACE_ROOT must identify an anchored Mon workspace')
    const parent = path.dirname(root)
    if (parent === root) return {}
    root = parent
  }
  root = realpathSync(root)
  const normalized = root.replaceAll('\\', '/').replace(/\/$/, '')
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return { monWorkspaceRoot: root, workspaceId: createHash('sha256').update(key).digest('hex') }
}
