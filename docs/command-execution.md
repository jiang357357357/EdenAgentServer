# 终端执行边界

Windows 使用 `powershell`，其他平台使用 `bash`；长命令返回进程会话，由 `write_stdin` 输入、轮询或终止。工具保持可发现，执行不可用时在描述和结构化错误中说明原因。

在聊天输入框的权限菜单中，分别选择审批策略和终端执行边界：

| 执行边界 | 行为 |
| --- | --- |
| 沙箱执行（默认） | 仅通过已验证的 OS 隔离器运行；不可用时拒绝执行，不自动降级 |
| 本机执行 | 用户勾选确认并应用后，以 Server 当前系统账户权限运行，不限制工作区外路径或联网 |

审批策略独立于执行边界：受限审批按规则确认副作用；命令审批自动允许其他工具、按规则确认终端命令；自动批准自动放行工具。已有明确授权的命令可以复用授权。已有 `permission.mode` 值不做静默迁移，切换审批不会开启本机执行。

推荐组合：默认使用沙箱加受限审批；需要操作可信本机环境时选择本机执行加命令审批；用户需要连续自动执行时可主动选择本机执行加自动批准。

## 平台支持

- Linux 自动发现 `bwrap`。启动时用无 profile 的 shell 执行 `exit 0`，5 秒内未成功则禁用该沙箱。权限菜单显示诊断原因。安装或修复隔离器后重启 Server。
- Windows 无内置 OS 沙箱时，用户可明确选择本机执行；PowerShell 优先解析 `pwsh.exe`，其次为 `powershell.exe`。
- `EDEN_AGENT_SANDBOX_EXECUTABLE` 仍可指定外部隔离器。指定路径失效不会回退为其他后端或本机执行。
- 外部隔离器接收 `--workspace <root> --cwd <cwd> --launcher <kind> -- <program> <args...>`。它必须自行提供隔离，不能使用普通 shell 冒充隔离器。启动探测只能验证可执行性，不是安全认证。
- Linux bubblewrap 默认根目录只读、工作区可写、独立临时目录和网络隔离。可额外允许联网、指定最多 16 个现存绝对目录为可写。允许联网意味着共享宿主网络，不是按域名授权。外部隔离器的访问规则由自身配置控制。

## 持久化与授权边界

`command.execution` 保存在当前世界 SQLite 中，重启恢复；另一个世界有独立设置。切换设置前需要结束运行中的终端进程。权限菜单明确显示当前执行边界、shell、可用性与错误。

本机执行不隔离当前 OS 账户可访问的其他目录，包括另一世界的数据；进程分离和数据库绑定不能替代 OS 访问控制。本机终端设置不自动放宽 MCP stdio 或技能代码的沙箱要求。

设置变更只暴露为面向用户的认证 RPC，不注册为模型工具。终端权限携带执行边界、工作区、网络设置和额外目录；实际执行前核对宿主审批结果，拒绝跨边界使用旧审批。设置写入成功后才更新内存；正在执行工具或仍有活动进程时拒绝切换。

## RPC

Rust 类型位于 `eden-agent-api`，TypeScript 客户端由 `npm run generate:rpc` 生成。

- `command.execution.get {}`：返回 `mode`、`networkAccess`、`writableRoots`、`available`、`sandboxAvailable`、`sandboxBackend`、`shell` 和 `detail`。
- `command.execution.set {mode, confirmHostExecution, networkAccess, writableRoots}`：`mode` 为 `sandbox` 或 `host`；写入 `host` 必须显式提供 `confirmHostExecution: true`。
- `/readyz` 的 `processSandbox` 表示基础沙箱探测结果，`commandExecution` 表示用户当前选择的终端执行能力；两者为可选健康项。

## 验证

```sh
cargo test -p eden-agent-tools -p eden-agent-workspace -p eden-agent-sandbox -p eden-agent-server --locked
npm --prefix frontend/web run typecheck
npm --prefix frontend/web test
```

测试包含默认关闭、本机显式确认、实际命令执行、审批结果核对、设置隔离与恢复、活动进程切换阻止、进程终止及失效外部隔离器。Windows 用同一组测试执行原生 PowerShell。

### 真实进程与协议验证

在完整工作区执行 `npm run test:command-live`。该命令编译 Server，并使用生成的 WebSocket RPC 客户端连接两个真实 Server，运行终端命令、审批、标准输入、进程终止、联网和强制重启恢复测试。Windows 使用 PowerShell，Linux 使用 Bash。

测试使用独立临时数据目录和端口；结束时停止测试服务，输出 JSON 报告及日志位置。模型响应来自本地确定性 HTTP 服务，因此验证的是生产进程、协议与执行链路，不是大模型自主选择工具的能力。真实大模型联调另需配置可用的模型服务。
