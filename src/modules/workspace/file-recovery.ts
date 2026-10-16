import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, lstat, realpath, readFile, writeFile, copyFile, unlink, chmod } from 'node:fs/promises'
import { workspaceFile } from './workspace-path.ts'

const recoveryDirectory = '.eden-shared-backups/agent-recovery'
type Action = 'delete' | 'rename'
export interface FileChange { action: Action; path: string; destination?: string; expectedSha256: string }
interface Recovery { version: 1; root: string; owner: string; path: string; destination?: string; action: Action; sha256: string; bytes: number; mode?: number }

export async function fileVersion(root: string, requested: string) {
  const filename = workspaceFile(root, requested)
  if (path.relative(root, filename).split(path.sep).includes('.eden-shared-backups')) throw new Error('恢复目录只能通过恢复工具访问')
  if ((await lstat(filename)).isSymbolicLink()) throw new Error('文件操作不允许符号链接')
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 1024 * 1024) throw new Error('仅支持不超过 1 MiB 的普通文件；不递归删除目录')
    const buffer = Buffer.alloc(before.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, bytesRead)
    const after = await handle.stat()
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('读取期间文件发生变化')
    return { filename, bytes, mode: before.mode & 0o777, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally { await handle.close() }
}

function destination(root: string, requested: string): string {
  const parent = workspaceFile(root, path.dirname(requested))
  const filename = path.join(parent, path.basename(requested))
  const relative = path.relative(root, filename)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('.eden-shared-backups')) throw new Error('目标路径越出工作区或进入恢复目录')
  return filename
}

async function recoveryRoot(root: string) {
  let directory = root
  for (const part of recoveryDirectory.split('/')) {
    directory = path.join(directory, part)
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('恢复目录不可用或被重定向')
  }
  return directory
}

export async function changeFile(root: string, owner: string, input: FileChange, signal: AbortSignal) {
  signal.throwIfAborted()
  const source = await fileVersion(root, input.path)
  if (source.sha256 !== input.expectedSha256) throw new Error('文件自读取或审批后发生变化，请重新读取')
  const target = input.action === 'rename' ? destination(root, input.destination!) : undefined
  if (target === source.filename) throw new Error('新旧文件路径相同')
  if (target) await lstat(target).then(() => { throw new Error('目标文件已存在，禁止覆盖') }, error => { if (error.code !== 'ENOENT') throw error })
  const recoveryId = randomUUID(), directory = path.join(await recoveryRoot(root), recoveryId)
  await mkdir(directory, { mode: 0o700 })
  const metadata: Recovery = { version: 1, root, owner, path: path.relative(root, source.filename),
    ...(target ? { destination: path.relative(root, target) } : {}), action: input.action, sha256: source.sha256, bytes: source.bytes.length, mode: source.mode }
  await writeFile(path.join(directory, 'content'), source.bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(directory, 'record.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 })
  signal.throwIfAborted()
  if ((await fileVersion(root, input.path)).sha256 !== input.expectedSha256) throw new Error(`文件发生变化，未删除；恢复副本 ${recoveryId}`)
  // Exclusive copy refuses existing targets and keeps the recovery bytes independent.
  try {
    if (target) {
      await copyFile(path.join(directory, 'content'), target, constants.COPYFILE_EXCL)
      await chmod(target, source.mode)
      if ((await fileVersion(root, input.path)).sha256 !== input.expectedSha256) throw new Error('复制期间原文件发生变化，原文件已保留')
    }
    await unlink(source.filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error
    throw unconfirmed(recoveryId, error)
  }
  return { path: input.path, ...(input.destination ? { destination: input.destination } : {}), action: input.action, recoveryId }
}

export async function readRecovery(root: string, owner: string, recoveryId: string) {
  if (!/^[a-f0-9-]{36}$/.test(recoveryId)) throw new Error('无效恢复编号')
  const directory = workspaceFile(root, path.join(recoveryDirectory, recoveryId))
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('恢复副本不可为链接')
  const metadata = JSON.parse(await readFile(workspaceFile(root, path.join(directory, 'record.json')), 'utf8')) as Recovery
  if (metadata.version !== 1 || metadata.owner !== owner || metadata.root !== root) throw new Error('恢复副本不属于当前会话和工作区')
  const content = workspaceFile(root, path.join(directory, 'content')), info = await lstat(content)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('恢复副本不是大小受限的普通文件')
  const bytes = await readFile(content)
  if (bytes.length > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('恢复副本校验失败')
  return { metadata, bytes, directory, target: destination(root, metadata.path) }
}

export async function restoreFile(root: string, owner: string, recoveryId: string, signal: AbortSignal) {
  const saved = await readRecovery(root, owner, recoveryId)
  signal.throwIfAborted()
  await writeFile(saved.target, saved.bytes, { flag: 'wx', mode: saved.metadata.mode ?? 0o600 }).catch(error => {
    if (error.code === 'EEXIST') throw error
    throw unconfirmed(recoveryId, error)
  })
  return { path: saved.metadata.path, restored: true, recoveryId }
}

function unconfirmed(recoveryId: string, cause: unknown) {
  return Object.assign(new Error(`文件操作未确认完成；先检查原路径和目标路径。恢复副本 ${recoveryId}`, { cause }), { toolOutcome: 'unknown' })
}
