import path from 'node:path'
import { accountKey, type Account } from '../accounts/index.ts'
import type { WorkspaceService } from '../workspace/index.ts'
import { discoverSharedWorkspace, type SharedInstallation } from './discovery.ts'
import { loadSharedWorkspace } from './loader.ts'
import { SharedLanOwner } from './lan-owner.ts'
import { SharedFolderRegistry, type SharedFolder } from './folder-registry.ts'
import { logDiagnostic } from '../logging/index.ts'
import { SharedDirectorySelection, type SharedDirectorySnapshot } from './directory-selection.ts'
import { SharedRestoreRetry } from './restore-retry.ts'
import type { CredentialLease, SharedClient, SharedClientFactory, SharedStatus, SharedRemote, SharedLanRuntime } from './contracts.ts'

interface Options {
  dataRoot: string
  account: Account | undefined
  workspace: Pick<WorkspaceService, 'info' | 'root' | 'mutate'> & Partial<Pick<WorkspaceService, 'forSession' | 'pinned' | 'restorePinned'>>
  discover?: () => SharedInstallation
  load?: () => Promise<SharedClientFactory>
  credentialActive?: () => boolean
  workspaceKey?: string
  onIdle?: () => void
  registry?: SharedFolderRegistry
  folder?: SharedFolder
  lanOwner?: SharedLanOwner
  lan?: SharedLanRuntime
  identityCheck?: () => Promise<void>
  selection?: SharedDirectorySelection
  assertSession?: (sessionId: string) => void
}

export class SharedWorkspaceService {
  private readonly leases = new Map<symbol, CredentialLease>()
  private readonly remote: SharedRemote
  private readonly lanOwner: SharedLanOwner
  private controller = new AbortController()
  private client: SharedClient | undefined
  private opening: Promise<SharedClient> | undefined
  private stopping: Promise<void> = Promise.resolve()
  private closed = false
  private fault: string | null = null
  private readonly folders = new Map<string, SharedWorkspaceService>()
  private readonly retiring = new Set<Promise<void>>()
  private active = 0
  private readonly registry: SharedFolderRegistry | undefined
  private restoring: Promise<void> | undefined
  private registryError: Error | undefined
  private restoreTimer: ReturnType<typeof setTimeout> | undefined
  private readonly restoreRetry = new SharedRestoreRetry()
  private readonly restoreFaults = new Map<string, { root: string; error: string }>()
  private readonly selection: SharedDirectorySelection
  private readonly reads = new Map<string, Map<string, string>>()

  constructor(private readonly options: Options) {
    this.selection = options.selection ?? new SharedDirectorySelection(path.join(options.dataRoot, 'shared-workspace-lan', 'selected-directory.json'), options.account?.key ?? '')
    this.registry = options.registry ?? (options.account && options.workspace.forSession
      ? new SharedFolderRegistry(path.join(options.dataRoot, 'shared-workspace-lan', 'folders.json'), options.account.key) : undefined)
    this.lanOwner = options.lanOwner ?? new SharedLanOwner({ dataRoot: path.join(options.dataRoot, 'shared-workspace-lan'),
      active: () => this.hasCredentials(), canPublish: () => !!this.installation().entry,
      load: options.load ?? loadSharedWorkspace, ...(options.lan ? { runtime: options.lan } : {}) })
    this.remote = this.lanOwner.remote
  }

  forSession(sessionId?: string): SharedWorkspaceService {
    if (sessionId) this.options.assertSession?.(sessionId)
    const info = this.selection.read()
    if (info.status !== 'ready') return this
    const identity = process.platform === 'win32' ? info.path.toLowerCase() : info.path
    const existing = this.folders.get(identity)
    if (existing) return existing
    if (!this.options.workspace.restorePinned) throw new Error('独立共享目录访问不可用')
    return this.folderService(this.options.workspace.restorePinned({ kind: 'external', root: info.path }),
      { root: info.path, kind: 'external', workspaceKey: `external:${info.path}` })
  }

  directory(sessionId: string) { this.options.assertSession?.(sessionId); this.requireAccount(); return this.selection.read() }
  selectDirectory(sessionId: string, root: string, revision: string) {
    this.options.assertSession?.(sessionId); this.requireAccount()
    return this.selection.select(root, revision)
  }
  directorySnapshot(): SharedDirectorySnapshot { return this.selection.read() }
  assertDirectorySnapshot(snapshot: SharedDirectorySnapshot, sessionId?: string) {
    if (sessionId) this.options.assertSession?.(sessionId)
    this.selection.assert(snapshot)
  }
  readHashes(scope: string) {
    let hashes = this.reads.get(scope)
    if (!hashes) { hashes = new Map(); this.reads.set(scope, hashes) }
    if (this.reads.size > 512) this.reads.delete(this.reads.keys().next().value!)
    return hashes
  }
  mutateFiles<T>(root: string, signal: AbortSignal, work: () => Promise<T>) {
    return this.options.workspace.mutate(root, signal, work)
  }

  private folderService(workspace: Options['workspace'], folder: SharedFolder): SharedWorkspaceService {
    const root = workspace.root()
    const identity = process.platform === 'win32' ? root.toLowerCase() : root
    const existing = this.folders.get(identity)
    if (existing) {
      if (existing.options.workspaceKey !== folder.workspaceKey) throw new Error('共享目录与其他已登记资料库路径冲突，请选择独立目录')
      this.folders.delete(identity)
      this.folders.set(identity, existing)
      return existing
    }
    const service = new SharedWorkspaceService({ ...this.options, selection: this.selection, workspace, folder: { ...folder, root }, ...(this.registry ? { registry: this.registry } : {}),
      workspaceKey: folder.workspaceKey, lanOwner: this.lanOwner,
      credentialActive: () => this.hasCredentials(), identityCheck: () => this.localIdentity(), onIdle: () => this.trimFolders(identity) })
    this.folders.set(identity, service)
    this.trimFolders(identity)
    return service
  }

  private trimFolders(current: string) {
    const idle = [...this.folders].filter(([, service]) => service.canRetire())
    for (const [key, service] of idle.filter(([key]) => key !== current).slice(0, Math.max(0, idle.length - 32))) {
      this.folders.delete(key)
      const closing = service.close().catch(error => { this.fault = message(error) })
      this.retiring.add(closing)
      void closing.finally(() => this.retiring.delete(closing))
    }
  }
  private canRetire(): boolean {
    if (this.active || this.opening) return false
    try {
      const status = this.client?.status()
      return !status || (!status.bound && status.state !== 'syncing' && !status.pending && !status.conflicts)
    } catch { return false }
  }
  private async withActivity<T>(work: () => Promise<T>): Promise<T> {
    this.active++
    try { return await work() } finally { this.active--; this.options.onIdle?.() }
  }

  private hasCredentials(): boolean {
    return !this.closed && (this.options.credentialActive?.() ?? this.leases.size > 0)
  }

  /** Only the verified WebSocket initialization path may register an in-memory credential lease. */
  attach(lease: CredentialLease): () => void {
    if (this.closed) throw new Error('共享资料库运行时已关闭')
    const id = Symbol('shared-workspace-connection')
    if (!this.leases.size) this.controller = new AbortController()
    this.leases.set(id, lease)
    {
      const services = [...this.folders.values()]
      for (const service of services) void service.withActivity(async () => { const client = await service.ensure(); if (service.hasCredentials()) client.start() })
        .catch(error => { service.fault = message(error) })
      this.queueRestoration()
    }
    return () => {
      if (!this.leases.delete(id) || this.leases.size) return
      this.suspend('共享资料库账号连接已关闭')
    }
  }

  folderFailures() { return [...this.restoreFaults].map(([workspaceKey, detail]) => ({ workspaceKey, ...detail })) }
  async backgroundReady(): Promise<void> { await this.restoring; if (this.registryError) throw this.registryError }
  private queueRestoration(): void {
    if (this.restoring || !this.registry || !this.options.workspace.restorePinned || !this.hasCredentials()) return
    if (!this.restoreRetry.canAttempt('registry')) { this.scheduleRestoreRetry(); return }
    const pending = this.restoreFolders().catch(error => {
      this.registryError = error instanceof Error ? error : new Error(message(error))
      if (this.restoreRetry.failed('registry', this.registryError.message))
        logDiagnostic({ event: 'shared_workspace.registry_restore_failed', error: this.registryError.message }, 'warn')
      throw error
    }).finally(() => {
      if (this.restoring === pending) this.restoring = undefined
      this.scheduleRestoreRetry()
    })
    this.restoring = pending
    void pending.catch(() => undefined)
  }
  private scheduleRestoreRetry(): void {
    clearTimeout(this.restoreTimer)
    if (!this.hasCredentials()) return
    const delay = this.restoreRetry.delay(this.registryError ? 'registry' : undefined)
    if (delay === undefined) return
    this.restoreTimer = setTimeout(() => { this.restoreTimer = undefined; this.queueRestoration() }, Math.max(1, delay))
    this.restoreTimer.unref()
  }
  private async restoreFolders() {
    if (!this.hasCredentials()) return
    const registry = await this.registry!.read()
    if (!this.hasCredentials()) return
    this.registryError = undefined
    this.restoreRetry.succeeded('registry')
    await Promise.all(registry.folders.map(async folder => {
      const retryKey = `folder:${folder.workspaceKey}`
      if (!this.restoreRetry.canAttempt(retryKey)) return
      try {
        if (!this.hasCredentials()) return
        const workspace = this.options.workspace.restorePinned!({ kind: 'external', root: folder.root }), service = this.folderService(workspace, folder)
        await service.withActivity(async () => { const client = await service.ensure(); if (service.hasCredentials()) client.start() })
        this.restoreFaults.delete(folder.workspaceKey)
        this.restoreRetry.succeeded(retryKey)
      } catch (error) {
        const detail = { root: folder.root, error: message(error) }
        this.restoreFaults.set(folder.workspaceKey, detail)
        if (this.restoreRetry.failed(retryKey, detail.error))
          logDiagnostic({ event: 'shared_workspace.folder_restore_failed', workspaceKey: folder.workspaceKey, ...detail }, 'warn')
      }
    }))
    this.selection.seedExisting(registry.folders.filter(folder => !this.restoreFaults.has(folder.workspaceKey)).map(folder => folder.root))
  }

  status(): Promise<ReturnType<SharedWorkspaceService['statusValue']>> {
    if (!this.options.folder && this.selection.read().status === 'ready') return this.forSession().status()
    return this.withActivity(() => this.readStatus())
  }
  private statusValue(empty: SharedStatus, publication: { canPublish: boolean; publishReason: string | null }, available: boolean, reason: string | null) {
    return { ...empty, ...publication, available, reason }
  }
  private async readStatus() {
    const publication = this.installation()
    const publishing = { canPublish: !!publication.entry, publishReason: publication.reason }
    const empty: SharedStatus = { bound: false, spaceId: null, paused: false, state: 'unbound', pending: 0,
      conflicts: 0, lastSync: null, error: this.registryError?.message ?? this.fault, root: this.options.folder?.root ?? this.selection.read().path }
    if (!this.options.folder) {
      try {
        this.requireAccount(); await this.localIdentity()
        const selected = this.selection.read()
        return this.statusValue(empty, publishing, selected.status === 'unselected', selected.error)
      } catch (error) { return this.statusValue(empty, publishing, false, message(error)) }
    }
    try { return { ...(await this.ensure()).status(), ...publishing, available: true, reason: null } }
    catch (error) { return { ...empty, ...publishing, error: message(error), available: false, reason: message(error) } }
  }

  async perform<T>(expectedPath: string, work: (client: SharedClient) => T | Promise<T>): Promise<T> {
    this.requireAccount()
    if (!this.options.folder) {
      const folder = this.forSession()
      if (folder === this) throw new Error('请先选择独立共享目录')
      return folder.perform(expectedPath, work)
    }
    return this.withActivity(async () => {
      this.assertWorkspace(expectedPath)
      const client = await this.ensure()
      this.assertWorkspace(expectedPath)
      const result = await work(client)
      this.assertWorkspace(expectedPath)
      await this.rememberBinding(client)
      return result
    })
  }

  async spaces(expectedPath: string) {
    return this.accountOperation(expectedPath, () => this.remote.request('GET', 'spaces'))
  }
  bindDirectory(expectedPath: string, spaceId: string): Promise<unknown> {
    if (!this.options.folder) {
      const folder = this.forSession()
      if (folder === this) throw new Error('请先选择独立共享目录')
      return folder.bindDirectory(expectedPath, spaceId)
    }
    return this.perform(expectedPath, client => this.mutateFiles(expectedPath, this.controller.signal, () => client.bind(spaceId)))
  }
  async create(expectedPath: string, name: string) {
    this.requirePublishing()
    return this.accountOperation(expectedPath, () => this.remote.request('POST', 'spaces', { name }))
  }
  async devices(expectedPath: string) {
    return this.accountOperation(expectedPath, () => this.remote.request('GET', 'devices'))
  }
  async revokeDevice(expectedPath: string, deviceId: string) {
    await this.accountOperation(expectedPath, () => this.remote.request('DELETE', `devices/${deviceId}`))
    return { revoked: true as const }
  }
  async network(expectedPath: string) { return this.accountOperation(expectedPath, async () => (await this.lanOwner.ensure()).network()) }
  async invitePairing(expectedPath: string) { return this.accountOperation(expectedPath, async () => (await this.lanOwner.ensure()).invite()) }
  async pairDevice(expectedPath: string, code: string, address?: string) { return this.accountOperation(expectedPath, async () => (await this.lanOwner.ensure()).pair(code, address)) }
  private accountOperation<T>(expectedPath: string, work: () => Promise<T>): Promise<T> {
    return this.withActivity(async () => {
      this.requireAccount(); await this.localIdentity(); this.assertWorkspace(expectedPath)
      const result = await work()
      this.assertWorkspace(expectedPath)
      return result
    })
  }
  async members(expectedPath: string, action: 'list' | 'set' | 'remove', deviceId?: string, role?: 'editor' | 'viewer') {
    return this.perform(expectedPath, client => {
      const spaceId = client.status().spaceId
      if (!spaceId) throw new Error('共享目录尚未绑定资料库')
      return this.remote.request(action === 'list' ? 'GET' : action === 'set' ? 'PUT' : 'DELETE',
        `spaces/${spaceId}/members`, action === 'list' ? undefined : { deviceId, ...(role ? { role } : {}) })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.restoreTimer)
    this.leases.clear()
    this.controller.abort(new Error('共享资料库运行时已关闭'))
    await this.restoring?.catch(() => undefined)
    await this.opening?.catch(() => undefined)
    await this.stopping.catch(() => undefined)
    await this.client?.close()
    await Promise.all([...this.folders.values()].map(service => service.close()))
    await Promise.all(this.retiring)
    if (!this.options.lanOwner) await this.lanOwner.close()
    await this.registry?.settled()
    this.folders.clear()
  }

  private installation() {
    if (!this.options.account) return { entry: null, reason: '共享资料库需要登录伊甸园账号' }
    return (this.options.discover ?? discoverSharedWorkspace)()
  }
  private assertWorkspace(expectedPath: string) {
    if (this.selection.read().path !== expectedPath) throw new Error('共享目录已切换，请重新打开共享资料库')
    if (this.options.folder && this.options.workspace.root() !== expectedPath) throw new Error('共享目录路径已改变')
  }
  private requireAccount() { if (!this.options.account) throw new Error('共享资料库需要登录伊甸园账号') }
  private requirePublishing() {
    const installation = this.installation()
    if (!installation.entry) {
      throw new Error(installation.reason ?? '发布目录需要启用共享资料库 DLC')
    }
    return installation.entry
  }
  private suspend(reason: string) {
    clearTimeout(this.restoreTimer)
    for (const service of this.folders.values()) service.suspend(reason)
    if (this.controller.signal.aborted) return
    this.controller.abort(new Error(reason))
    this.stopping = this.stopping.catch(() => undefined).then(async () => { await this.client?.suspend() })
    void this.stopping.catch(error => { this.fault = message(error) })
    if (!this.options.lanOwner) void this.lanOwner.suspend().catch(error => { this.fault = message(error) })
  }
  private async ensure(): Promise<SharedClient> {
    this.requireAccount()
    if (!this.hasCredentials()) throw new Error('共享资料库需要已验证的账号连接')
    await this.localIdentity()
    await this.stopping
    if (!this.hasCredentials()) throw new Error('共享资料库账号连接已关闭')
    if (this.controller.signal.aborted) {
      this.controller = new AbortController()
      this.client?.start()
    }
    if (this.client) return this.client
    if (this.opening) return this.opening
    const pending = this.open()
    this.opening = pending
    try { return await pending } finally { if (this.opening === pending) this.opening = undefined }
  }
  private async open(): Promise<SharedClient> {
    const factory = await this.lanOwner.clientFactory()
    const capabilities = await this.remote.request<{ protocolVersion: number }>('GET', 'capabilities')
    if (capabilities.protocolVersion !== 2) throw new Error('共享资料库局域网协议不兼容')
    this.requireAccount()
    if (!this.hasCredentials()) throw new Error('共享资料库账号连接已关闭')
    this.client = factory({ dataRoot: path.join(this.options.dataRoot, 'shared-workspace-lan'), remote: this.remote,
      workspace: () => {
        const info = this.options.workspace.info()
        return { root: this.options.workspace.root(), key: this.options.workspaceKey ?? (info.kind === 'managed' ? 'managed:default' : `external:${info.path}`) }
      },
      mutate: (root, work) => {
        this.requireAccount()
        return this.options.workspace.mutate(root, this.controller.signal, async () => {
          this.requireAccount()
          if (!this.hasCredentials()) throw new Error('共享资料库账号连接已关闭')
          return work()
        })
      },
    })
    this.fault = null
    await this.rememberBinding(this.client)
    if (this.options.lanOwner && this.hasCredentials()) this.client.start()
    return this.client
  }
  private async rememberBinding(client: SharedClient) {
    if (this.registry && this.options.folder && client.status().bound) await this.registry.remember(this.options.folder)
  }
  private async localIdentity(): Promise<void> {
    if (this.options.identityCheck) return this.options.identityCheck()
    for (const [id, lease] of [...this.leases].reverse()) {
      const value = await lease()
      if (!this.leases.has(id)) continue
      if (value.accountKey !== this.options.account?.key || accountKey(value.coreBaseUrl, this.options.account.userId) !== value.accountKey)
        throw new Error('本机账号或 Core 身份不匹配')
      return
    }
    throw new Error('共享资料库账号连接已关闭')
  }
}
function message(error: unknown) { return error instanceof Error ? error.message : '共享资料库操作失败' }
