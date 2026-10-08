import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const savedSchema = z.object({ version: z.literal(1), accountKey: z.string(), path: z.string().min(1), revision: z.string().uuid() }).strict()
export interface SharedDirectorySnapshot { path: string; revision: string; status: 'unselected' | 'ready' | 'invalid'; error: string | null }

/** Account-private selection. It never reads or writes a session's workspace settings. */
export class SharedDirectorySelection {
  constructor(private readonly filename: string, private readonly accountKey: string) {}

  read(): SharedDirectorySnapshot {
    let data: z.infer<typeof savedSchema>
    try {
      const stat = lstatSync(this.filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('共享目录选择记录无效')
      data = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      if (data.accountKey !== this.accountKey) throw new Error('共享目录选择记录属于其他账号')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: '', revision: '0', status: 'unselected', error: null }
      throw error
    }
    try {
      if (this.canonical(data.path) !== data.path) throw new Error('共享目录已被重定向，请重新选择')
      return { path: data.path, revision: data.revision, status: 'ready', error: null }
    } catch (error) {
      return { path: data.path, revision: data.revision, status: 'invalid', error: (error as Error).message }
    }
  }

  select(requested: string, expectedRevision: string): SharedDirectorySnapshot {
    const current = this.read()
    if (current.revision !== expectedRevision) throw new Error('共享目录选择已改变，请刷新后重试')
    const root = this.canonical(requested)
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, accountKey: this.accountKey, path: root, revision: randomUUID() }) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.filename)
    } finally { rmSync(temporary, { force: true }) }
    return this.read()
  }

  assert(snapshot: SharedDirectorySnapshot): void {
    const current = this.read()
    if (current.status !== snapshot.status || current.path !== snapshot.path || current.revision !== snapshot.revision)
      throw new Error('共享目录在操作或审批期间发生变化，请重新提交')
  }

  seedExisting(roots: string[]): void {
    if (this.read().status !== 'unselected' || roots.length !== 1) return
    // Preserve a single explicitly registered legacy binding; never adopt the current workspace.
    this.select(roots[0]!, '0')
  }

  private canonical(requested: string): string {
    if (!path.isAbsolute(requested) || requested.includes('\0')) throw new Error('共享目录必须是有效的绝对路径')
    const root = realpathSync(requested)
    if (!statSync(root).isDirectory()) throw new Error('共享目录必须是文件夹')
    return root
  }
}
