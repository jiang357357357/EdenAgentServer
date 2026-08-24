<div align="center">

# MonAgent Rust Server

**The local backend, persistence layer, and extension host for MonAgent**

[![Integration CI](https://github.com/jiang357357357/MonAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/jiang357357357/MonAgent/actions/workflows/ci.yml)
![Rust 1.85+](https://img.shields.io/badge/Rust-1.85%2B-dea584?logo=rust&logoColor=white)
![Tokio](https://img.shields.io/badge/runtime-Tokio-5566cc)
![SQLite](https://img.shields.io/badge/storage-SQLite-003b57?logo=sqlite&logoColor=white)
![Version](https://img.shields.io/badge/version-1.8.0-e67700)

[简体中文](README.md) · **English** · [Main repository](https://github.com/jiang357357357/MonAgent)

</div>

## Overview

`mon-agent-server` is the only local backend process used by MonAgent. It links the host-independent `AgentCore` Rust crates directly and exposes capability-token-protected WebSocket JSON-RPC and Blob HTTP endpoints.

The Server owns process boundaries and external side effects:

- SQLite persistence for events, sessions, jobs, and extension state
- OpenAI-compatible model providers and streaming responses
- Permission approval, capability tokens, and OS sandboxing
- Workspace, Blob, skills, plugins, MCP, and multi-agent orchestration
- Installable connectors and external worker lifecycles
- Mon business tools and desktop-runtime coordination

## Runtime path

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

Events are persisted before they are broadcast to clients. The Rust types in `mon-agent-api` and the generated TypeScript client are the single source of truth for the frontend protocol.

## Development

Run from the complete MonAgent workspace:

```bash
git clone --recurse-submodules https://github.com/jiang357357357/MonAgent.git
cd MonAgent
cargo run -p mon-agent-server
```

Or use the project script:

```bash
npm run dev:server
```

The default listener is `127.0.0.1:40092`. Health check:

```bash
curl http://127.0.0.1:40092/readyz
```

## Configuration

For desktop use, local model configuration is normally managed through **Configuration → Model Service**. The Server also accepts environment variables:

| Variable | Purpose |
| --- | --- |
| `MON_AGENT_MODEL=provider/model` | Select a model, for example `openai/gpt-4o-mini` |
| `<PROVIDER>_API_KEY` | Provider credential, with `OPENAI_API_KEY` as a fallback |
| `MON_AGENT_BASE_URL` / `OPENAI_BASE_URL` | OpenAI-compatible API endpoint |
| `MON_AGENT_DATABASE` | SQLite database path |
| `MON_AGENT_BLOB_ROOT` | Blob storage directory |
| `MON_AGENT_WORKSPACE_ROOT` | Default workspace root |
| `MON_AGENT_CAPABILITY_TOKEN` | Client capability token; written to a token file when omitted |
| `MON_CORE_BASE_URL` / `MON_CORE_TOKEN` | Enable Mon business tools |
| `MON_AGENT_SANDBOX_EXECUTABLE` | Select an external command sandbox |

Never commit real credentials to source files, example configuration, test fixtures, or runtime logs.

## Protocol

- `/rpc`: WebSocket JSON-RPC
- `/blobs`: Blob upload and retrieval
- `/readyz`: service health check

There is no legacy REST/SSE compatibility layer. Regenerate the client after changing `mon-agent-api` types:

```bash
npm run generate:rpc
```

## Security boundary

- The service binds to the loopback interface by default.
- File writes, command execution, external communication, connector actions, skill changes, and job scheduling go through permission policy.
- Command tools are registered only when an OS sandbox is available; otherwise they fail closed.
- `AgentCore` does not depend on HTTP, SQLite, a model provider, Electron, or Mon Core.
- Process launch, networking, and persistence are centralized in the Server.

## Verification

Run from the complete workspace root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## Further reading

- [Multi-agent orchestration](docs/orchestration.md)
- [Subagents](docs/subagents.md)
- [Long-term all-Rust server architecture](https://github.com/jiang357357357/MonAgent/blob/main/文档/技术/MonAgent%20全%20Rust%20服务端长期架构方案.md) (Chinese)
- [Frontend and Electron-Core responsibilities](https://github.com/jiang357357357/MonAgent/blob/main/文档/技术/MonAgent%20前端与%20Electron-Core%20职责边界说明.md) (Chinese)
- [Installable connector protocol and package format](https://github.com/jiang357357357/MonAgent/blob/main/文档/技术/MonAgent%20可安装连接器协议与包格式.md) (Chinese)

## License

Current versions are source-available for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use requires a [separate written commercial license](COMMERCIAL-LICENSE.md). Third-party dependencies, connector content, game assets, models, data, and trademarks are not automatically included in either licensing path.
