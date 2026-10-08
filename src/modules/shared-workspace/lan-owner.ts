import type { SharedClientFactory, SharedLanRuntime, SharedRemote } from './contracts.ts'

/** One listener, pairing identity and catalog per local account; folders share this owner. */
export class SharedLanOwner {
  private runtime: SharedLanRuntime | undefined
  private opening: Promise<SharedLanRuntime> | undefined
  private factory: SharedClientFactory | undefined
  private stopping: Promise<void> = Promise.resolve()
  private closed = false
  readonly remote: SharedRemote
  constructor(private readonly options: { dataRoot: string; active(): boolean; canPublish(): boolean;
    load(): Promise<SharedClientFactory>; runtime?: SharedLanRuntime }) {
    this.runtime = options.runtime
    this.remote = {
      request: async (method, path, body) => (await this.ensure()).remote.request(method, path, body),
      upload: async (id, hash, bytes) => (await this.ensure()).remote.upload(id, hash, bytes),
      download: async (id, hash) => (await this.ensure()).remote.download(id, hash),
    }
  }
  async clientFactory(): Promise<SharedClientFactory> {
    this.factory ??= await this.options.load()
    return this.factory
  }
  async ensure(): Promise<SharedLanRuntime> {
    if (this.closed || !this.options.active()) throw new Error('局域网共享未启用或本机账号未连接')
    await this.stopping
    if (this.closed || !this.options.active()) throw new Error('局域网共享连接已关闭')
    if (this.runtime) { await this.runtime.start(); return this.runtime }
    if (this.opening) return this.opening
    const pending = this.open(); this.opening = pending
    try { return await pending } finally { if (this.opening === pending) this.opening = undefined }
  }
  private async open(): Promise<SharedLanRuntime> {
    const factory = await this.clientFactory()
    if (!factory.createLanRuntime) throw new Error('共享资料库 DLC 缺少局域网协议 2，请更新配套源码')
    const runtime = await factory.createLanRuntime({ dataRoot: this.options.dataRoot, active: () => !this.closed && this.options.active(), canPublish: () => this.options.canPublish() })
    if (this.closed || !this.options.active()) { await runtime.close(); throw new Error('局域网共享连接已关闭') }
    this.runtime = runtime; return runtime
  }
  suspend(): Promise<void> {
    const work = this.stopping.catch(() => undefined).then(async () => { await this.opening?.catch(() => undefined); await this.runtime?.suspend() })
    this.stopping = work; return work
  }
  async close() { this.closed = true; await this.suspend(); await this.runtime?.close() }
}
