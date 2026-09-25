import os from 'node:os'
import { open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { EdenDatabase } from '@eden/store'
import { WorkspaceRepository } from './workspace-repository.ts'
import { workspaceRoot, workspaceFile } from './workspace-path.ts'
import { WorkspaceMutationQueue } from './mutation-queue.ts'
import { readWorkspacePage } from './workspace-read-page.ts'

export class WorkspaceService {
  private readonly repository: WorkspaceRepository
  private readonly mutations = new WorkspaceMutationQueue()
  private readonly modelReads = new Map<string, Map<string, string>>()

  async readForModel(_scope: string, requested: string, offset = 0, limit = 65536) {
    return readWorkspacePage(this.root(), requested, offset, limit)
  }

  rememberWrite(scope: string, requested: string, content: string) {
    const reads = this.modelReads.get(scope) ?? new Map<string, string>()
    reads.set(workspaceFile(this.root(), requested), createHash('sha256').update(content).digest('hex'))
    this.modelReads.set(scope, reads)
    if (this.modelReads.size > 512) this.modelReads.delete(this.modelReads.keys().next().value!)
  }

  async writeSnapshot(scope: string, requested: string): Promise<string | null> {
    try {
      const filename = workspaceFile(this.root(), requested)
      const known = this.modelReads.get(scope)?.get(filename)
      if (known) return known
      const current = await this.read(requested)
      if (!current.sha256) throw new Error('File is too large to safely replace')
      return current.sha256
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.modelReads.get(scope)?.get(path.resolve(this.root(), requested)) ?? null
      throw error
    }
  }
  constructor(database: EdenDatabase, private readonly protectedRoots: readonly string[]) {
    this.repository = new WorkspaceRepository(database)
  }

  info() {
    const root = this.repository.read()
    return { name: root ? path.basename(root) : 'No workspace selected', path: root ?? '' }
  }

  root(): string {
    const saved = this.repository.read()
    if (!saved) throw new Error('Select a workspace first')
    const canonical = workspaceRoot(saved, this.protectedRoots)
    if (canonical !== saved) throw new Error('Workspace path changed; select it again')
    return canonical
  }

  commandRoot(): string {
    return this.repository.read() ? this.root() : workspaceRoot(os.homedir(), [])
  }

  async mutateCommand<T>(root: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return this.mutations.run(signal, async () => {
      if (this.commandRoot() !== root) throw new Error('Workspace changed after permission request')
      return work()
    })
  }

  switch(root: string) {
    const canonical = workspaceRoot(root, this.protectedRoots)
    this.repository.set(canonical)
    return { currentPath: canonical, pendingPath: null, pendingSessionId: null, requestedAt: null, updatedAt: Date.now() }
  }

  async mutate<T>(root: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return this.mutations.run(signal, async () => {
      if (this.root() !== root) throw new Error('Workspace changed after permission request')
      return work()
    })
  }

  async list(requested: string) {
    const root = this.root()
    const filename = workspaceFile(root, requested)
    const entries = await readdir(filename, { withFileTypes: true })
    const visible = entries.filter(entry => entry.isFile() || entry.isDirectory())
    if (visible.length > 5000) throw new Error('Directory exceeds 5000 entries; choose a narrower directory')
    return { root, path: filename, entries: visible.map(entry => ({ name: entry.name, path: path.join(filename, entry.name), type: entry.isDirectory() ? 'directory' : 'file' })) }
  }

  async read(requested: string) {
    const root = this.root()
    const filename = workspaceFile(root, requested)
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('Workspace path is not a regular file')
      const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const content = buffer.subarray(0, bytesRead)
      let decoded = ''
      let binary = content.includes(0)
      if (!binary) {
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content) }
        catch { binary = true }
      }
      return { name: path.basename(filename), path: filename, size: stat.size, binary,
        truncated: stat.size > bytesRead, content: binary ? '' : decoded,
        sha256: stat.size === bytesRead ? createHash('sha256').update(content).digest('hex') : null }
    } finally { await file.close() }
  }
}
