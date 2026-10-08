import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const folderSchema = z.object({ workspaceKey: z.string(), kind: z.enum(['managed', 'external']), root: z.string() }).strict()
  .refine(value => path.isAbsolute(value.root) && !value.root.includes('\0')
    && value.workspaceKey === (value.kind === 'managed' ? 'managed:default' : `external:${value.root}`), 'Invalid shared folder identity')
const registrySchema = z.object({ version: z.literal(1), accountKey: z.string(), folders: z.array(folderSchema) }).strict()
export type SharedFolder = z.infer<typeof folderSchema>

/** Account-private directory identities only. Credentials and session history never enter this file. */
export class SharedFolderRegistry {
  private loaded: Promise<SharedFolder[]> | undefined
  private saving: Promise<void> = Promise.resolve()
  private missing = false
  constructor(private readonly filename: string, private readonly accountKey: string) {}

  async read(): Promise<{ folders: SharedFolder[]; missing: boolean }> {
    const folders = await (this.loaded ??= this.load().catch(error => { this.loaded = undefined; throw error }))
    return { folders: [...folders], missing: this.missing }
  }
  remember(folder: SharedFolder): Promise<void> {
    folderSchema.parse(folder)
    const next = this.saving.catch(() => undefined).then(async () => {
      const { folders } = await this.read(), previous = folders.find(item => item.workspaceKey === folder.workspaceKey)
      if (previous?.root === folder.root && previous.kind === folder.kind) return
      const updated = [...folders.filter(item => item.workspaceKey !== folder.workspaceKey), folder]
      await this.save(updated)
      this.loaded = Promise.resolve(updated)
      this.missing = false
    })
    this.saving = next
    return next
  }
  async settled(): Promise<void> { await this.saving.catch(() => undefined) }

  private async load(): Promise<SharedFolder[]> {
    try {
      const stat = await lstat(this.filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('共享目录注册表无效')
      const data = registrySchema.parse(JSON.parse(await readFile(this.filename, 'utf8')))
      if (data.accountKey !== this.accountKey) throw new Error('共享目录注册表属于其他账号')
      return data.folders
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.missing = true
      return []
    }
  }
  private async save(folders: SharedFolder[]): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, accountKey: this.accountKey, folders }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.filename)
    } finally { await rm(temporary, { force: true }) }
  }
}
