import type { SharedClientFactory, SharedLanRuntime, SharedRemote } from './contracts.ts'
import { HostDeploymentJobs } from './host-deployment-jobs.ts'
import path from 'node:path'
import { SharedPostureSelection, type SharedPosture } from './posture-selection.ts'

/** One listener, pairing identity and catalog per local account; folders share this owner. */
export class SharedLanOwner {
  private runtime: SharedLanRuntime | undefined
  private opening: Promise<SharedLanRuntime> | undefined
  private factory: SharedClientFactory | undefined
  private stopping: Promise<void> = Promise.resolve()
  private closed = false
  private transition: Promise<unknown> | undefined
  readonly posture: SharedPostureSelection
  readonly remote: SharedRemote
  readonly deployments: HostDeploymentJobs
  constructor(private readonly options: { dataRoot: string; active(): boolean; canPublish(): boolean;
    load(): Promise<SharedClientFactory>; runtime?: SharedLanRuntime; runtimeBundleRoot?(): string | undefined; accountKey?: string }) {
    this.posture = new SharedPostureSelection(path.join(options.dataRoot, 'posture.json'), options.accountKey ?? '')
    this.runtime = options.runtime
    this.deployments = new HostDeploymentJobs({ active: () => !this.closed && options.active(),
      canPublish: () => options.canPublish() && this.posture.read().mode === 'cloud', runtime: () => this.ensure(),
      ...(options.runtimeBundleRoot ? { runtimeBundleRoot: options.runtimeBundleRoot } : {}) })
    this.remote = {
      request: async (method, path, body) => (await this.ensure()).remote.request(method, path, body),
      upload: async (id, hash, bytes) => (await this.ensure()).remote.upload(id, hash, bytes),
      download: async (id, hash) => (await this.ensure()).remote.download(id, hash),
    }
  }
  async selectPosture(mode: SharedPosture, expectedRevision: string, quiesce: () => Promise<void>) {
    if (this.transition) throw new Error('共享姿态正在切换，请稍后重试')
    const current = this.posture.assertRevision(expectedRevision)
    if (current.mode === mode) return current
    if (this.deployments.status()?.state === 'running') throw new Error('请先完成或取消云主机部署，再切换共享姿态')
    const work = (async () => {
      await this.opening?.catch(() => undefined)
      await this.runtime?.suspend(); await quiesce()
      await this.runtime?.close(); this.runtime = undefined
      if (this.closed || !this.options.active()) throw new Error('共享资料库账号连接已关闭')
      return this.posture.select(mode, expectedRevision)
    })()
    this.transition = work
    try { return await work } finally { if (this.transition === work) this.transition = undefined }
  }
  async clientFactory(): Promise<SharedClientFactory> {
    this.factory ??= await this.options.load()
    return this.factory
  }
  async ensure(): Promise<SharedLanRuntime> {
    if (this.closed || !this.options.active()) throw new Error('局域网共享未启用或本机账号未连接')
    await this.stopping
    if (this.transition) throw new Error('共享姿态正在切换，请稍后重试')
    if (this.closed || !this.options.active()) throw new Error('局域网共享连接已关闭')
    if (this.runtime) { await this.runtime.start(); return this.runtime }
    if (this.opening) return this.opening
    const pending = this.open(); this.opening = pending
    try { return await pending } finally { if (this.opening === pending) this.opening = undefined }
  }
  private async open(): Promise<SharedLanRuntime> {
    const factory = await this.clientFactory()
    if (!factory.createLanRuntime) throw new Error('共享资料库 DLC 缺少局域网协议 2，请更新配套源码')
    const posture = this.posture.read().mode
    const runtime = await factory.createLanRuntime({ dataRoot: this.options.dataRoot, active: () => !this.closed && this.options.active(),
      canPublish: () => this.options.canPublish() && this.posture.read().mode === 'lan', connectionPosture: posture,
      discovery: posture === 'lan', ...(posture === 'cloud' ? { host: '127.0.0.1' } : {}) })
    if (this.closed || !this.options.active()) { await runtime.close(); throw new Error('局域网共享连接已关闭') }
    this.runtime = runtime; return runtime
  }
  suspend(): Promise<void> {
    this.deployments.suspend()
    const work = this.stopping.catch(() => undefined).then(async () => { await this.opening?.catch(() => undefined); await this.runtime?.suspend() })
    this.stopping = work; return work
  }
  async close() { this.closed = true; await this.suspend(); await this.runtime?.close() }
}
