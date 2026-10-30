import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import { hostRuntimeBundle, unpackHostRuntime, hostRuntimeFiles, type HostRuntimeAsset } from './host-runtime-bundle.ts'

const labels = { node: 'Node.js', monpm: 'MonPM', libstdcpp: 'C++ 运行库', libgcc: '基础运行库' }

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => {
    if (error) reject(new Error('无法建立 SFTP 文件传输，请检查 SSH 服务器配置'))
    else { sftp.on('error', () => {}); resolve(sftp) }
  }))
}
function transfer(sftp: SFTPWrapper, source: string, target: string, asset: HostRuntimeAsset,
  progress: (done: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(source, target, { concurrency: 16, chunkSize: 32 * 1024, mode: 0o700,
      step: done => { try { progress(done, asset.rawSize) } catch (error) { sftp.destroy(); reject(error) } },
    }, error => error ? reject(new Error('上传远端运行环境失败，请检查磁盘空间、目录权限及 SSH 连接')) : resolve())
  })
}
async function remoteStage(sftp: SFTPWrapper): Promise<string> {
  const home = await new Promise<string>((resolve, reject) => sftp.realpath('.', (error, value) => error ? reject(error) : resolve(value)))
  if (!path.posix.isAbsolute(home) || /[\r\n\0]/.test(home)) throw new Error('SSH 用户主目录无效')
  const stage = path.posix.join(home, `.eden-shared-bootstrap-${randomUUID()}`)
  await new Promise<void>((resolve, reject) => sftp.mkdir(stage, { mode: 0o700 }, error => error ? reject(error) : resolve()))
  return stage
}
async function verifyUploaded(sftp: SFTPWrapper, remote: string, local: string, asset: HostRuntimeAsset): Promise<void> {
  await new Promise<void>((resolve, reject) => sftp.fastGet(remote, local, { concurrency: 16, chunkSize: 32 * 1024 },
    error => error ? reject(new Error('无法读取远端运行环境进行校验')) : resolve()))
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of createReadStream(local)) { size += bytes.length; hash.update(bytes) }
  if (size !== asset.rawSize || hash.digest('hex') !== asset.rawSha256) throw new Error('远端运行环境上传 SHA-256 校验失败')
}
async function cleanStage(sftp: SFTPWrapper, stage: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = async () => {
    for (const name of Object.values(hostRuntimeFiles)) await new Promise<void>(resolve => sftp.unlink(path.posix.join(stage, name), () => resolve()))
    await new Promise<void>(resolve => sftp.rmdir(stage, () => resolve()))
  }
  try { await Promise.race([work(), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000) })]) }
  finally { clearTimeout(timer) }
}

export async function uploadHostRuntimes(client: Client, root: string | undefined, architecture: 'x64' | 'arm64',
  signal: AbortSignal, progress: (name: string, done: number, total: number) => void) {
  signal.throwIfAborted()
  const bundle = await hostRuntimeBundle(root, architecture)
  const names = ['node', 'monpm', 'libstdcpp', 'libgcc'] as const
  const local = await mkdtemp(path.join(tmpdir(), 'eden-host-runtime-'))
  let sftp: SFTPWrapper | undefined, stage: string | undefined
  const abort = () => client.destroy()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => client.destroy(), 20 * 60_000)
  try {
    for (const name of names) await unpackHostRuntime(bundle, bundle[name], path.join(local, name), signal)
    sftp = await openSftp(client); signal.throwIfAborted()
    stage = await remoteStage(sftp)
    for (const name of names) {
      await transfer(sftp, path.join(local, name), path.posix.join(stage, hostRuntimeFiles[name]), bundle[name], (done, total) => {
        signal.throwIfAborted(); progress(labels[name], done, total)
      })
      const info = await new Promise<{ size: number }>((resolve, reject) => sftp!.stat(path.posix.join(stage!, hostRuntimeFiles[name]), (error, value) => error ? reject(error) : resolve(value)))
      if (info.size !== bundle[name].rawSize) throw new Error('远端运行环境上传大小不符')
      progress(`${labels[name]} 远端校验`, bundle[name].rawSize, bundle[name].rawSize)
      await verifyUploaded(sftp, path.posix.join(stage, hostRuntimeFiles[name]), path.join(local, `${name}.verified`), bundle[name])
    }
    const remote = stage, connection = sftp
    const asset = (name: typeof names[number]) => ({ path: path.posix.join(remote, hostRuntimeFiles[name]), size: bundle[name].rawSize, sha256: bundle[name].rawSha256 })
    return { id: bundle.id, notices: bundle.notices, libraryPath: remote,
      node: asset('node'), monpm: asset('monpm'), libstdcpp: asset('libstdcpp'), libgcc: asset('libgcc'),
      async cleanup() { await cleanStage(connection, remote); connection.end() } }
  } catch (error) {
    if (stage && sftp && !signal.aborted) await cleanStage(sftp, stage)
    sftp?.end(); throw error
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); await rm(local, { recursive: true, force: true }) }
}
