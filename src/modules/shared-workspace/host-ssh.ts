import { createHash } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import type { SharedHostDeploymentInput, SharedSshTarget } from '@eden/api'
import { shellArgument, sshCommand } from './host-ssh-command.ts'

function fingerprint(key: Buffer) { return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` }
function connection(target: SharedSshTarget): ConnectConfig {
  return { host: target.host, port: target.port, username: target.username, readyTimeout: 15_000,
    keepaliveInterval: 10_000, keepaliveCountMax: 3, tryKeyboard: false,
    algorithms: { compress: ['zlib@openssh.com', 'none'] } }
}

/** Probe terminates at key exchange, before attempting password/key authentication. */
export async function probeSshHost(target: SharedSshTarget, signal: AbortSignal): Promise<{ fingerprint: string }> {
  signal.throwIfAborted()
  const client = new Client()
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => { client.destroy(); reject(new Error('SSH 指纹读取已取消')) }
      signal.addEventListener('abort', abort, { once: true })
      client.once('close', () => { signal.removeEventListener('abort', abort); reject(new Error('SSH 连接已关闭，未读取到主机指纹')) })
      client.once('error', () => reject(new Error('无法读取 SSH 主机指纹，请检查地址、端口和 SSH 服务')))
      client.connect({ ...connection(target), hostVerifier: (key: Buffer) => { resolve({ fingerprint: fingerprint(key) }); return false } })
    })
  } finally { client.destroy() }
}

export async function connectSsh(input: SharedHostDeploymentInput, signal: AbortSignal): Promise<Client> {
  signal.throwIfAborted()
  const client = new Client()
  let mismatch = false
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { client.destroy(); reject(new Error('SSH 连接已取消')) }
      signal.addEventListener('abort', abort, { once: true })
      client.once('close', () => { signal.removeEventListener('abort', abort); reject(new Error('SSH 连接在认证完成前关闭')) })
      client.once('ready', resolve)
      client.on('error', () => reject(new Error(mismatch ? 'SSH 主机指纹不匹配，部署已停止' : 'SSH 连接或认证失败，请检查连接信息')))
      const auth = input.auth.type === 'password' ? { password: input.auth.password }
        : { privateKey: input.auth.privateKey, ...(input.auth.passphrase ? { passphrase: input.auth.passphrase } : {}) }
      try { client.connect({ ...connection(input), ...auth, hostVerifier: (key: Buffer) => { mismatch = fingerprint(key) !== input.fingerprint; return !mismatch } }) }
      catch { reject(new Error('SSH 私钥格式或口令无效，请检查认证信息')) }
    })
    signal.throwIfAborted()
    return client
  } catch (error) { client.destroy(); throw error }
}

/** Executable is one shell argument; deployment parameters and source travel only over stdin. */
export function sshNodeScript(client: Client, executable: string, script: string, signal: AbortSignal,
  onLine: (line: string) => void, libraryPath?: string): Promise<void> {
  const environment = libraryPath ? `LD_LIBRARY_PATH=${shellArgument(libraryPath)} ` : ''
  return sshCommand(client, `${environment}${shellArgument(executable)} --input-type=module`, script, signal, onLine)
}
