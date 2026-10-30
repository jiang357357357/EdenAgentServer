import { StringDecoder } from 'node:string_decoder'
import type { Client } from 'ssh2'

export function shellArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('远端命令路径无效')
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Fixed command; user parameters and source are sent over stdin, never composed as shell code. */
export function sshCommand(client: Client, command: string, stdin: string, signal: AbortSignal,
  onLine: (line: string) => void, timeout = 120_000): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let ended = false, pending = '', count = 0
    const decoder = new StringDecoder('utf8')
    const finish = (error?: Error) => {
      if (ended) return
      ended = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    const abort = () => { client.destroy(); finish(new Error('部署已取消；若远端已启动，请检查主机状态')) }
    const timer = setTimeout(() => { client.destroy(); finish(new Error('SSH 部署超时，请检查远端主机状态')) }, timeout)
    signal.addEventListener('abort', abort, { once: true })
    client.exec(command, (error, channel) => {
      if (error) { finish(new Error('无法执行远端部署命令，请检查 SSH 服务')); return }
      channel.on('data', (data: Buffer) => {
        if (ended) return
        count += data.length
        if (count > 128 * 1024) { client.destroy(); finish(new Error('远端部署输出超出限制')); return }
        pending += decoder.write(data)
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          try { onLine(line) } catch { client.destroy(); finish(new Error('远端部署响应无效')); return }
        }
      })
      channel.stderr.resume()
      channel.once('error', () => finish(new Error('远端部署通道中断，请检查主机状态')))
      channel.once('close', (code: number | null) => finish(code === 0 ? undefined : new Error('远端部署命令失败，请检查主机系统兼容性及目录权限')))
      client.once('close', () => finish(new Error('SSH 连接已关闭，请检查远端主机状态')))
      channel.end(stdin)
    })
  })
}

export async function sshSystemArchitecture(client: Client, signal: AbortSignal): Promise<'x64' | 'arm64'> {
  const lines: string[] = []
  await sshCommand(client, 'uname -sm', '', signal, line => lines.push(line), 20_000)
  const platform = lines.join('\n').trim()
  if (platform === 'Linux x86_64') return 'x64'
  if (platform === 'Linux aarch64' || platform === 'Linux arm64') return 'arm64'
  throw new Error('自动部署支持 x64 / ARM64 Linux 主机，请检查操作系统与 CPU 架构')
}

export async function sshNodeNeedsPrivateLibraries(client: Client, node: string, signal: AbortSignal): Promise<boolean> {
  const lines: string[] = []
  try { await sshCommand(client, `${shellArgument(node)} --version`, '', signal, line => lines.push(line), 20_000) }
  catch { signal.throwIfAborted(); return true }
  if (lines.join('\n').trim() !== 'v22.23.1') throw new Error('上传的 Node.js 版本不符')
  return false
}
