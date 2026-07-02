# Mon Agent Server

Python implementation of the MonAgent local HTTP server.

It keeps the existing frontend-facing API shape and loads the Python
`mon_agent_core` package from the sibling `AgentCore` submodule at runtime.

## Development

Install or refresh the Python environment:

```bash
./Script/EnvTools/linux/install_env.sh
```

From the Agent root:

```bash
npm run dev:server
```

From this directory:

```bash
uv run python -m mon_agent_server
```

Health check:

```bash
curl http://127.0.0.1:40092/api/tools/status
```
