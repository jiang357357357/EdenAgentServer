# 子智能体配置

Eden Agent 内置 `general`、`researcher`、`coder`、`reviewer` 四个任务角色。它们是后台任务配置，不是伊芙、莉莉安等聊天角色。

可以在以下目录新增或覆盖角色：

1. 用户级：`~/.edenagent/agents/*.toml`
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
thinking_level = "high"

# 可选：使用 Core 中另一条 AI 实体配置；省略时继承父会话模型。
# ai_entity_id = 12

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
- `thinking_level`：可选，`off`、`minimal`、`low`、`medium`、`high`、`xhigh`。
- `budget.max_turns`：同一线程累计允许的最大模型轮次，默认 `64`。
- `budget.max_tool_calls`：同一线程累计允许执行的最大工具调用数，默认 `128`。
- `budget.timeout_seconds`：同一线程累计模型与工具执行时间，默认 `1800` 秒。
- `ai_entity_id`：可选，Core 中的 AI 实体 ID。
- `allowed_tools`：可选的工具允许列表。
- `denied_tools`：可选的工具禁止列表。

`read-only` 是运行时强制允许列表。即使角色加载了 `workspace-development`，也不会获得 `write`、`edit` 或 `bash`。嵌套子智能体只能继承或收窄父级策略，不能通过创建 `coder` 扩大权限。

预算同样只能继承或收窄。运行时会在工具执行前检查工具预算，在每个模型轮次结束时检查轮次预算，并通过异步超时机械终止超时任务。使用量会进入检查点，重启或继续线程后不会清零。

## 独立线程持久化

子智能体的线程数据默认保存在 `<workspace>/Data/AgentThreads`。可以通过 `EDEN_AGENT_THREAD_STORE_DIR` 修改位置；相对路径以工作区为基准。

每条线程分别保存：

- `thread.json`：路径、角色、状态、模型和最终结果。
- `events.jsonl`：追加式模型、工具和恢复事件。
- `checkpoint.json`：完整模型消息、已加载技能、推理级别和实际工具策略。

元数据和检查点使用原子替换，事件使用追加式 JSONL。读取时会忽略进程异常退出造成的不完整末行。

服务重启后，无法继续的旧网络请求会从 `queued/running/waiting` 校正为 `interrupted`。用户可以在聊天页的子智能体卡片中选择“继续”，运行时会使用检查点重新构造同一线程并执行追加任务。系统不会伪装成能够续接已经断开的模型 HTTP 流。

父子智能体之间尚未消费的消息保存在会话级 `mailboxes.json`。消息投递和消费分别落盘，因此服务重启后，尚未被父智能体读取的结果和排队中的追加任务不会丢失。运行中收到的追加任务会在当前轮结束后自动启动下一轮；显式中断则不会自动继续。

## 运行限制

以下环境变量用于限制子智能体资源占用，非法值会回退默认值，过大或过小的值会被限制在安全范围内：

- `EDEN_AGENT_SUBAGENT_MAX_THREADS`：单个根会话最多保留的线程数，默认 `64`。
- `EDEN_AGENT_SUBAGENT_MAX_CONCURRENT_PER_SESSION`：单个根会话同时运行数，默认 `4`。
- `EDEN_AGENT_SUBAGENT_MAX_CONCURRENT_GLOBAL`：当前 Server 内所有会话合计的模型执行并发，默认 `8`。
- `EDEN_AGENT_SUBAGENT_MAX_DEPTH`：子智能体嵌套深度，默认 `2`，最高 `8`。
