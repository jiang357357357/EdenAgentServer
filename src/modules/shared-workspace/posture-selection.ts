import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export type SharedPosture = 'lan' | 'cloud'
export interface SharedPostureSnapshot { mode: SharedPosture; revision: string }
const savedSchema = z.object({ version: z.literal(1), accountKey: z.string(), mode: z.enum(['lan', 'cloud']), revision: z.string().uuid() }).strict()

/** An account-owned operating posture; selecting the current posture never unlocks it. */
export class SharedPostureSelection {
  constructor(private readonly filename: string, private readonly accountKey: string) {}
  read(): SharedPostureSnapshot {
    try {
      const info = lstatSync(this.filename)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('共享姿态记录无效')
      const saved = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      if (saved.accountKey !== this.accountKey) throw new Error('共享姿态记录属于其他账号')
      return { mode: saved.mode, revision: saved.revision }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'lan', revision: '0' }
      throw error
    }
  }
  assertRevision(expected: string): SharedPostureSnapshot {
    const current = this.read()
    if (current.revision !== expected) throw new Error('共享姿态已被其他窗口修改，请刷新后重试')
    return current
  }
  select(mode: SharedPosture, expected: string): SharedPostureSnapshot {
    const current = this.assertRevision(expected)
    if (current.mode === mode) return current
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, accountKey: this.accountKey, mode, revision: randomUUID() }) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.filename)
    } finally { rmSync(temporary, { force: true }) }
    return this.read()
  }
}
