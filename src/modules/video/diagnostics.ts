import type { launchMcpProcess } from '@eden/execution'

type Diagnostics = ReturnType<Awaited<ReturnType<typeof launchMcpProcess>>['diagnostics']>

export function videoWorkerFailure(name: string, cause: unknown, diagnostics: Diagnostics, cleanupError?: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  const details = [`视频工具 ${name} 调用失败：${message.slice(0, 2000)}`]
  if (diagnostics.stderrLimitExceeded) details.push('工作进程 stderr 超过 1 MiB，已被宿主终止。')
  if (!diagnostics.terminationRequested && diagnostics.exitCode !== null)
    details.push(`工作进程退出码：${diagnostics.exitCode}`)
  if (diagnostics.stderr.trim()) details.push(`工作进程诊断${diagnostics.stderrTruncated ? '（末尾片段）' : ''}：\n${diagnostics.stderr.trim().slice(-2000)}`)
  if (cleanupError !== undefined) details.push('工作进程清理失败，尚未确认退出。')
  return new Error(details.join('\n'), { cause })
}
