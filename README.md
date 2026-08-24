# MonAgent Rust Server

`mon-agent-server` 是 MonAgent 唯一的本地后端进程。它直接依赖 `AgentCore` 的 Rust library crates，并提供带能力令牌的 WebSocket JSON-RPC、Blob HTTP 端点、SQLite 持久化、模型适配、权限审批、技能、多智能体、作业和连接器宿主。

## 授权

当前版本以 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供非商业源码使用；商业使用必须取得[单独书面商业授权](COMMERCIAL-LICENSE.md)。此前在 MIT 条款下取得的历史版本继续适用其随附的 MIT 条款。第三方依赖、连接器内容、游戏素材、模型、数据和商标不自动包含在上述授权中。

## 开发运行

从仓库根目录执行：

```bash
npm run dev:server
```

或直接执行：

```bash
cargo run -p mon-agent-server
```

健康检查：

```bash
curl http://127.0.0.1:40092/readyz
```

本地配置主要通过环境变量注入：

- `MON_AGENT_MODEL=provider/model`
- 对应模型供应商的 API Key 与 Base URL
- `MON_AGENT_DATABASE`、`MON_AGENT_BLOB_ROOT`、`MON_AGENT_WORKSPACE_ROOT`
- `MON_AGENT_CAPABILITY_TOKEN`（未提供时写入 `MON_AGENT_TOKEN_FILE`）
- `MON_CORE_BASE_URL` 与 `MON_CORE_TOKEN`（启用 Mon 业务工具时）
- `MON_AGENT_SANDBOX_EXECUTABLE`（平台没有内置隔离器时）

服务默认仅绑定 `127.0.0.1:40092`。命令工具在没有可用 OS 沙箱时保持禁用；写文件、外部通信、连接器动作、技能变更和作业调度均经过权限策略。

## 协议与类型

前端只使用 `/rpc` 的 JSON-RPC 和 `/blobs`；不提供旧 REST/SSE 兼容层。Rust API 类型生成 TypeScript 客户端：

```bash
npm run generate:rpc
```

架构边界见 `文档/技术/MonAgent 全 Rust 服务端长期架构方案.md`；架构切换历史见 `文档/技术/MonAgent 全 Rust 迁移执行清单.md`。完整产品能力迁移及当前待复验项以 `文档/技术/MonAgent 全 Rust 完整功能迁移计划.md` 和 `文档/技术/MonAgent 归档行为验收矩阵.md` 为准。
