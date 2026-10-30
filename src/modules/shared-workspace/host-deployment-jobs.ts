import { createHash, randomUUID } from 'node:crypto'
import type { SharedHostDeploymentInput, SharedHostDeploymentJob } from '@eden/api'
import { normalizeSharedHostAddress } from '@eden/shared-workspace'
import type { SharedLanRuntime } from './contracts.ts'
import { createHostDeployment, hostInstallerTemplate } from './host-deployment.ts'
import { connectSsh, sshNodeScript } from './host-ssh.ts'
import { sshSystemArchitecture, sshNodeNeedsPrivateLibraries } from './host-ssh-command.ts'
import { uploadHostRuntimes } from './host-runtime-upload.ts'

const messages = {
  connecting: '正在连接 SSH', dependencies: '正在自动准备 Node.js 和 MonPM', preflight: '正在检查系统和安装目录',
  uploading: '正在上传并校验共享主机文件', starting: '正在通过 MonPM 启动共享主机',
  pairing: '主机已启动，正在从本机连接并登记管理员', done: '共享主机已部署并连接',
}
const failures: Record<string, string> = {
  linux_required: 'SSH 自动部署当前支持 Linux 云主机', node_version: '云主机需要 Node.js 22.23.1 或更新版本',
  monpm_missing: '自动准备的 MonPM 无法运行，请检查系统兼容性与目录权限', monpm_version: '部署包中的 MonPM 不支持当前协议，请更新完整 DLC',
  runtime_corrupt: '主机已有运行环境校验失败，请检查安装目录；原服务保持现状',
  unsafe_path: '安装目录的归属、层级或符号链接不符合要求，请选择当前 SSH 用户的独立目录',
  wrong_owner: '此目录由另一台子机部署，请使用原管理员子机或选择新目录',
  unmanaged_directory: '目标目录包含其他文件或其他 MonPM 应用，请选择空目录',
  deployment_busy: '该目录正在部署，请稍后重试', hash_mismatch: '上传文件校验失败',
  host_not_ready: 'MonPM 已尝试启动，但共享主机尚未就绪，请检查远端日志和端口',
}
interface Job { value: SharedHostDeploymentJob; controller: AbortController }
function deploymentFailure(job: SharedHostDeploymentJob, error: unknown): string {
  const message = error instanceof Error ? error.message : '主机部署失败'
  return job.phase === 'pairing' ? `共享主机已启动，但连接或管理员配对未完成：${message}。请检查访问地址、共享端口和云防火墙，再重新连接已启动的主机` : message
}

/** Owned by one verified account's LAN identity; credentials exist only inside the running operation. */
export class HostDeploymentJobs {
  private readonly jobs = new Map<string, Job>()
  constructor(private readonly options: { active(): boolean; canPublish(): boolean; runtime(): Promise<SharedLanRuntime>;
    runtimeBundleRoot?(): string | undefined }) {}

  start(input: SharedHostDeploymentInput): SharedHostDeploymentJob {
    this.assertActive()
    if ([...this.jobs.values()].some(job => job.value.state === 'running')) throw new Error('当前账号已有正在进行的主机部署')
    const address = normalizeSharedHostAddress(input.publicAddress)
    // Direct deployment starts an HTTP listener. HTTPS is configured separately at the server/reverse proxy.
    if (new URL(address).protocol !== 'http:') throw new Error('直接部署请填写 http://IP:端口；HTTPS 请在服务器配置证书后连接')
    const id = randomUUID(), job: Job = { controller: new AbortController(),
      value: { id, state: 'running', phase: 'connecting', message: messages.connecting, updatedAt: Date.now(), hostStarted: false, address } }
    this.jobs.set(id, job)
    for (const [key, old] of this.jobs) if (this.jobs.size > 8 && old.value.state !== 'running') this.jobs.delete(key)
    void this.run(job, { ...input, publicAddress: address })
    return { ...job.value }
  }
  status(id?: string): SharedHostDeploymentJob | null {
    if (!this.options.active()) throw new Error('共享资料库账号连接已关闭')
    if (!id) { const last = [...this.jobs.values()].at(-1); return last ? { ...last.value } : null }
    const job = this.jobs.get(id)
    if (!job) throw new Error('部署任务不存在或已过期')
    return { ...job.value }
  }
  cancel(id: string) {
    this.status(id)
    const job = this.jobs.get(id)!
    if (job.value.state === 'running') {
      job.controller.abort()
      this.update(job, { state: 'cancelled', message: '部署已取消；若远端已启动，请检查该主机的 MonPM 状态' })
    }
    return { ...job.value }
  }
  suspend() {
    for (const job of this.jobs.values()) if (job.value.state === 'running') {
      job.controller.abort()
      this.update(job, { state: 'cancelled', message: '账号连接关闭，部署已取消；请检查远端主机状态' })
    }
  }
  private assertActive() {
    if (!this.options.active()) throw new Error('共享资料库账号连接已关闭')
    if (!this.options.canPublish()) throw new Error('部署共享主机需要启用共享资料库 DLC')
  }
  private update(job: Job, change: Partial<SharedHostDeploymentJob>) { Object.assign(job.value, change, { updatedAt: Date.now() }) }
  private uploadProgress(job: Job) {
    let lastProgress = 0
    return (name: string, done: number, total: number) => {
      if (Date.now() - lastProgress < 250 && done !== total) return
      this.assertActive()
      lastProgress = Date.now()
      this.update(job, { message: `正在上传 ${name}：${Math.ceil(done / 1048576)} / ${Math.ceil(total / 1048576)} MiB` })
    }
  }
  private receive(job: Job, line: string): string {
    const event = JSON.parse(line) as Record<string, unknown>
    job.controller.signal.throwIfAborted(); this.assertActive()
    if (event.phase === 'dependencies' || event.phase === 'preflight' || event.phase === 'uploading' || event.phase === 'starting')
      this.update(job, { phase: event.phase, message: messages[event.phase] })
    if (event.event === 'started') this.update(job, { hostStarted: true, bootService: event.bootService === true })
    if (event.event === 'ready' || event.event === 'prepared') this.receiveReady(job, event)
    return event.event === 'error' ? failures[String(event.code)] ?? '云端安装失败，请检查系统兼容性、目录权限和 MonPM 日志' : ''
  }
  private receiveReady(job: Job, event: Record<string, unknown>) {
    if (typeof event.directory === 'string' && event.directory.length <= 4096) this.update(job, { directory: event.directory })
    if (typeof event.code === 'string' && event.code.length <= 4096) this.update(job, { pairingCode: event.code, hostStarted: true })
  }
  private async run(job: Job, input: SharedHostDeploymentInput): Promise<void> {
    const signal = job.controller.signal
    let client: Awaited<ReturnType<typeof connectSsh>> | undefined
    let uploaded: Awaited<ReturnType<typeof uploadHostRuntimes>> | undefined
    let remoteFailure = ''
    try {
      const runtime = await this.options.runtime(), administrator = runtime.deploymentIdentity()
      const [host, installer] = await Promise.all([createHostDeployment(administrator), hostInstallerTemplate()])
      this.assertActive(); signal.throwIfAborted()
      client = await connectSsh(input, signal)
      const architecture = await sshSystemArchitecture(client, signal)
      this.update(job, { phase: 'dependencies', message: messages.dependencies })
      uploaded = await uploadHostRuntimes(client, this.options.runtimeBundleRoot?.(), architecture, signal, this.uploadProgress(job))
      const usePrivateLibraries = await sshNodeNeedsPrivateLibraries(client, uploaded.node.path, signal)
      const payload = { directory: input.directory, name: input.name, servicePort: input.servicePort,
        publicAddress: input.publicAddress, monpmPath: uploaded.monpm.path, installService: input.installService, administrator, contentBase64: host.contentBase64,
        runtime: { id: uploaded.id, node: uploaded.node, monpm: uploaded.monpm, libstdcpp: uploaded.libstdcpp,
          libgcc: uploaded.libgcc, notices: uploaded.notices, usePrivateLibraries },
        sha256: createHash('sha256').update(Buffer.from(host.contentBase64, 'base64')).digest('hex') }
      await sshNodeScript(client, uploaded.node.path, `const edenDeploymentInput = ${JSON.stringify(payload)};\n${installer}`, signal, line => {
        remoteFailure = this.receive(job, line) || remoteFailure
      }, usePrivateLibraries ? uploaded.libraryPath : undefined)
      await uploaded.cleanup(); uploaded = undefined
      client.end(); client = undefined
      this.assertActive(); signal.throwIfAborted()
      if (!job.value.pairingCode) throw new Error('云主机未返回有效配对邀请')
      this.update(job, { phase: 'pairing', message: messages.pairing })
      const paired = await runtime.connectHost(job.value.pairingCode, input.publicAddress)
      signal.throwIfAborted(); this.assertActive()
      delete job.value.pairingCode
      this.update(job, { state: 'succeeded', phase: 'done', message: messages.done, deviceId: paired.deviceId })
    } catch (error) {
      if (!signal.aborted) this.update(job, { state: 'failed', message: remoteFailure || deploymentFailure(job.value, error) })
    } finally { await uploaded?.cleanup().catch(() => undefined); client?.destroy() }
  }
}
