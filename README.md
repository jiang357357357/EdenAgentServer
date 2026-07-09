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

Logs are written from the Agent workspace root to:

```bash
Data/Logs/Text/MonAgent/MonAgent.log
Data/Logs/Text/MonAgent/MonAgent_plain.log
```

The server uses the MonAgent logging package, modeled after MonCore
`DjangoLogs`: console output, colored file output, plain text file output, size
rotation, and a standard-library logging bridge share one handler registry.
Additional logger mains are written under `Data/Logs/Text/<Main>/<Main>.log`.

MonHub registration is optional service discovery. Disable it for standalone
debug runs with `MON_AGENT_HUB_ENABLED=false`.

## External Email

External email is owned by Core and MonOs, not by this Agent server.

- Core stores the user mailbox configuration.
- MonOs `Email` performs SMTP delivery.
- MonMcp exposes `email_status` and `email_send`.
- MonAgent only registers conversation tools that call the Core user context.

Use the Core/Web settings page to configure the mailbox. The Agent tool names
are `external_email_status` and `send_external_email`.
