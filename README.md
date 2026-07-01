# Mon Agent Server

Python implementation of the MonAgent local HTTP server.

It keeps the existing frontend-facing API shape and loads the Python
`mon_agent_core` package from the sibling `AgentCore` submodule at runtime.

## Development

From the Agent root:

```bash
bun run dev:server
```

From this directory:

```bash
PYTHONPATH=src:../AgentCore/src python3 -m mon_agent_server
```

Health check:

```bash
curl http://127.0.0.1:40092/api/tools/status
```
