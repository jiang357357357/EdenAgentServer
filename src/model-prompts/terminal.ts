import type { TerminalTarget } from '@eden/api'

export function terminalToolContext(terminal: TerminalTarget | null): string {
  const shell = terminal?.kind === 'wsl'
    ? `WSL ${terminal.distribution}，优先使用启用 pipefail 的 bash，无 bash 时使用 /bin/sh 并在支持时启用 pipefail`
    : process.platform === 'win32' ? '本机 PowerShell' : '本机 /bin/sh'
  const rules = [
    `当前终端：${shell}。`,
    '每次调用是独立 shell，环境变量、cd 和 shell 选项不跨调用保留；文件工具直接访问当前工作区，不依赖 WSL。',
    'Node 脚本受最近上层 package.json 的 type 影响；临时 CommonJS 脚本用 .cjs，ES 模块用 .mjs。',
    '检查关键步骤的真实退出码；后续成功命令、未启用 pipefail 的管道或 || true 都可能掩盖失败。',
  ]
  if (terminal?.kind === 'wsl') rules.push(
    '跨调用临时文件优先放到 "$TMPDIR"，宿主为当前工作目录提供用户主目录下的持久临时目录；/tmp 可能是 tmpfs，发行版停止或重启后内容不保留。',
    'WSL 的后台进程、nohup 和 systemd 服务不保证 Windows 开机自启或发行版持续运行；不能仅凭一次 HTTP 成功承诺重启后可用。超时或取消后执行结果可能未知，先核实再决定是否重试。',
  )
  return rules.join('\n')
}
