<div align="center">

# MonAgent Rust Server

**MonAgent 的本地后端、持久化与扩展宿主**

[![Integration CI](https://github.com/jiang357357357/MonAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/jiang357357357/MonAgent/actions/workflows/ci.yml)
![Rust 1.85+](https://img.shields.io/badge/Rust-1.85%2B-dea584?logo=rust&logoColor=white)
![Tokio](https://img.shields.io/badge/runtime-Tokio-5566cc)
![SQLite](https://img.shields.io/badge/storage-SQLite-003b57?logo=sqlite&logoColor=white)
![Version](https://img.shields.io/badge/version-1.8.0-e67700)

**简体中文** · [English](README.en.md) · [主仓库](https://github.com/jiang357357357/MonAgent)

</div>

## 简介

`mon-agent-server` 是 MonAgent 唯一的本地后端进程。它直接链接宿主无关的 `AgentCore` Rust crates，并对外提供带能力令牌的 WebSocket JSON-RPC 与 Blob HTTP 端点。

Server 负责所有进程边界和外部副作用：

- SQLite 事件、会话、作业和扩展状态持久化
- OpenAI 兼容模型供应商与流式响应
- 权限审批、能力令牌和操作系统沙箱
- 工作区、Blob、技能、插件、MCP 与多智能体
- 可安装连接器及外部 worker 生命周期
- Mon 业务工具和桌面运行时协调

## 运行链路

```mermaid
flowchart LR
    Client[Web / Electron] -->|WS JSON-RPC| API[mon-agent-api]
    Client -->|HTTP Blob| Blob[mon-agent-blob]
    API --> App[mon-agent-app]
    App --> Core[AgentCore]
    App --> Store[(mon-agent-store / SQLite)]
    App --> Provider[mon-agent-provider]
    App --> Extensions[skills / plugins / MCP / connectors]
    Extensions --> Sandbox[permissions / sandbox]
```

事件先写入持久化层，再广播给客户端。前端协议以 `mon-agent-api` 的 Rust 类型和生成的 TypeScript 客户端为唯一事实来源。

## 开发运行

推荐从完整 MonAgent 工作区运行：

```bash
git clone --recurse-submodules https://github.com/jiang357357357/MonAgent.git
cd MonAgent
cargo run -p mon-agent-server
```

也可以使用项目脚本：

```bash
npm run dev:server
```

默认监听 `127.0.0.1:40092`。健康检查：

```bash
curl http://127.0.0.1:40092/readyz
```

## 配置

桌面模式推荐通过 **配置 → 模型服务** 管理本地模型配置。服务端也支持环境变量：

| 变量 | 用途 |
| --- | --- |
| `MON_AGENT_MODEL=provider/model` | 选择模型，例如 `openai/gpt-4o-mini` |
| `<PROVIDER>_API_KEY` | 对应供应商密钥；可回退到 `OPENAI_API_KEY` |
| `MON_AGENT_BASE_URL` / `OPENAI_BASE_URL` | OpenAI 兼容 API 地址 |
| `MON_AGENT_DATABASE` | SQLite 数据库路径 |
| `MON_AGENT_BLOB_ROOT` | Blob 存储目录 |
| `MON_AGENT_WORKSPACE_ROOT` | 默认工作区根目录 |
| `MON_AGENT_CAPABILITY_TOKEN` | 客户端能力令牌；未提供时写入令牌文件 |
| `MON_CORE_BASE_URL` / `MON_CORE_TOKEN` | 启用 Mon 业务工具 |
| `MON_AGENT_SANDBOX_EXECUTABLE` | 指定外部命令隔离器 |

不要把真实密钥提交到仓库、示例配置、测试夹具或运行日志。

## 协议

- `/rpc`：WebSocket JSON-RPC
- `/blobs`：Blob 上传与读取
- `/readyz`：服务健康检查

本项目不提供旧 REST/SSE 兼容层。修改 `mon-agent-api` 类型后需重新生成客户端：

```bash
npm run generate:rpc
```

## 安全边界

- 默认只绑定回环地址。
- 写文件、执行命令、外部通信、连接器动作、技能变更和作业调度均经过权限策略。
- 命令工具只有在可用的操作系统沙箱中才注册；缺少沙箱时故障关闭。
- `AgentCore` 不依赖 HTTP、SQLite、具体供应商、Electron 或 Mon Core。
- 进程启动、网络访问和持久化由 Server 统一管理。

## 验证

从完整工作区根目录执行：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## 延伸阅读

- [多智能体编排](docs/orchestration.md)
- [子智能体](docs/subagents.md)
- [全 Rust 服务端长期架构方案](https://github.com/jiang357357357/MonAgent/blob/main/文档/技术/MonAgent%20全%20Rust%20服务端长期架构方案.md)
- [前端与 Electron-Core 职责边界](https://github.com/jiang357357357/MonAgent/blob/main/文档/技术/MonAgent%20前端与%20Electron-Core%20职责边界说明.md)
- [可安装连接器协议与包格式](https://github.com/jiang357357357/MonAgent/blob/main/文档/技术/MonAgent%20可安装连接器协议与包格式.md)

## 许可证

当前版本依据 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供非商业源码使用。商业使用需要[单独书面商业授权](COMMERCIAL-LICENSE.md)。第三方依赖、连接器内容、游戏素材、模型、数据和商标不自动包含在上述授权中。
