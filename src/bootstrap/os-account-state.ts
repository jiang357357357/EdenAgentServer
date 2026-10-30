import { existsSync, mkdirSync, cpSync, renameSync, lstatSync, chmodSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readState, saveState } from '../modules/os/index.ts'
import type { OsConfig } from '../modules/os/index.ts'
import { logDiagnostic } from '../modules/logging/index.ts'

/** A new binding never adopts another account's clock. Originals remain available for rollback. */
export function migrateOsAccountState(config: OsConfig): void {
  if (!config.identity || !config.legacyWakeDir || existsSync(path.join(config.wakeDir, 'ownership.json'))) return
  const root = config.legacyWakeDir
  const manifest = readState(path.join(root, 'role-coordinator.json')), state = readState(path.join(root, 'state.json'))
  const owners = [manifest.user_id, state.pending_submission?.user_id].filter(v => v !== undefined && v !== null).map(String)
  const owned = owners.length > 0 && owners.every(id => id === config.identity!.userId)
  if (owned) {
    copyState(root, config.wakeDir)
    if (config.legacyMemoDir) copyState(config.legacyMemoDir, config.memoDir)
  } else {
    mkdirSync(config.wakeDir, { recursive: true, mode: 0o700 })
    if (Object.keys(state).length || Object.keys(manifest).length) logDiagnostic({ event: 'os.legacy_state.retained',
      message: '旧调度文件归属未匹配当前账号，已保留原文件；当前账号使用独立调度目录。' }, 'warn')
  }
  saveState(path.join(config.wakeDir, 'ownership.json'), { schemaVersion: 1, userId: config.identity.userId,
    coreBaseUrl: config.identity.coreBaseUrl, legacyStateCopied: owned })
}

function copyState(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) return
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(source), `.agent-os-migrating-${randomUUID()}`)
  cpSync(source, temporary, { recursive: true, filter(filename) {
    const relative = path.relative(source, filename), parts = relative.split(path.sep)
    if (parts[0] === 'accounts' || relative.includes('.tmp')) return false
    const info = lstatSync(filename)
    if (info.isSymbolicLink()) throw new Error('旧调度数据不能包含重定向链接')
    return info.isDirectory() || filename.endsWith('.json')
  } })
  restrictState(temporary)
  renameSync(temporary, target)
}
function restrictState(directory: string): void {
  chmodSync(directory, 0o700)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) restrictState(filename)
    else chmodSync(filename, 0o600)
  }
}
