# 子智能体配置

Eden Agent 内置 `general`、`researcher`、`coder`、`reviewer` 四个任务角色。它们是后台任务配置，不是伊芙、莉莉安等聊天角色。

可以在以下目录新增或覆盖角色：

1. 用户级：`EDEN_AGENT_USER_AGENT_ROOT` 指定目录下的 `*.toml`；未设置时为进程工作目录下的 `Data/agents/*.toml`。开发与桌面启动器会指定当前世界独立的 `agents` 目录
2. 项目级：`<workspace>/.edenagent/agents/*.toml`

项目级配置优先于用户级配置，用户级配置优先于内置配置。服务启动时会校验所有文件；修改配置后需要重启 Eden Agent Server。

```toml
name = "security-reviewer"
description = "只读检查安全风险和权限边界"
developer_instructions = """
追踪真实执行路径并提供文件与符号位置。
优先报告可复现的安全问题，不修改文件。
"""

sandbox_mode = "read-only"
skills = ["web-research"]
reasoning = "high"

# 可选：覆盖继承的模型标识；实际可用性取决于宿主供应商配置。
# model = "provider/model"

# 可选：在 sandbox_mode 的基础上进一步收窄。
denied_tools = ["analyze_screen"]

[budget]
max_turns = 64
max_tool_calls = 128
timeout_seconds = 1800
```

## 字段

- `name`：必填，稳定的小写角色名。
- `description`：必填，供主智能体判断何时使用。
- `developer_instructions`：必填，子智能体的核心工作要求。
- `sandbox_mode`：`inherit`、`read-only` 或 `workspace-write`。
- `skills`：启动时预加载的技能。
- `reasoning`：可选，`off`、`minimal`、`low`、`medium`、`high`、`xhigh`。
- `budget.max_turns`：同一线程累计允许的最大模型轮次，默认 `64`。
- `budget.max_tool_calls`：同一线程累计允许执行的最大工具调用数，默认 `128`。
- `budget.timeout_seconds`：线程的墙钟期限，默认 `1800` 秒；排队和服务停机也会消耗期限。
- `model`：可选，模型 ID 或 `provider/model`；省略时继承父级模型规格。
- `allowed_tools`：可选的工具允许列表。
- `denied_tools`：可选的工具禁止列表。

`read-only` 是运行时强制允许列表。即使角色加载了 `workspace-development`，也不会获得 `write`、`edit`、`bash` 或 `powershell`。嵌套子智能体只能继承或收窄父级策略，不能通过创建 `coder` 扩大权限。

预算同样只能继承或收窄。运行时会在工具执行前检查工具预算，在每个模型轮次结束时检查轮次预算，并通过异步超时机械终止超时任务。使用量会进入检查点，重启或继续线程后不会清零。

## 线程持久化与恢复

子智能体使用当前世界 Server 的 SQLite 数据库，与主会话共享 Store。开发默认分别位于 `Data/realms/mon` 和 `Data/realms/local`；打包桌面端使用 Electron 用户数据目录下的 `server/realms/<origin>`。实际数据库路径由 `EDEN_AGENT_DATABASE` 指定。

- `agent_threads`：线程身份、父子关系、状态、结果，以及 `context_json` 上下文检查点、`config_json` 配置快照、`usage_json` 用量和 `deadline_at` 截止时间。
- `session_events`：持久化运行事件，提交后广播给客户端。
- `agent_mailbox`：父子智能体消息及消费状态。

当前 Rust 运行时不使用 `thread.json`、`events.jsonl`、`checkpoint.json` 或 `mailboxes.json` 保存线程，也不读取 `EDEN_AGENT_THREAD_STORE_DIR`。

Server 启动恢复时将 `running` 线程改为 `queued`，再调度待执行线程，使用已有检查点恢复上下文。恢复会重新发起模型请求，不会续接旧 HTTP 流。使用量和截止时间保持持久化值；额度耗尽或期限已过会限制后续执行。显式中断的线程不会由启动恢复自动排队，可由用户追加任务继续。

工具操作日志与线程检查点分别持久化。服务重启时，已开始但未确认结果的操作标记为 `unknown`，需要复核，不能把恢复理解为外部副作用的恰好一次执行保证。

## 运行限制

当前 Server 创建 `MultiAgentService` 时设置单进程全局执行并发为 `4`，伊甸园和尘世分别计数。子智能体嵌套深度最多为 `3`，第一层子智能体深度为 `1`。这些值当前由 Rust 代码设置；旧文档中的 `EDEN_AGENT_SUBAGENT_MAX_*` 环境变量不再是有效配置入口。

角色预算可配置 `max_turns`、`max_tool_calls`、`timeout_seconds`、`max_tokens` 和 `max_cost_microusd`；后两项默认分别为 `1_000_000` token 和 `10_000_000` 微美元。成本计数依赖供应商报告的用量与费用。嵌套子智能体只能继承或收窄父级预算和工具策略。
