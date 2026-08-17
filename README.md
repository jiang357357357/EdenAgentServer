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

The server is a local-only service and listens on the fixed default endpoint
`http://127.0.0.1:40092`.

## Installable skills

MonAgent separates skill ownership across three layers:

- Core stores the authenticated user's installation metadata.
- Agent Server inspects, installs, updates, enables and removes skill files.
- AgentCore provides the immutable `ResourceSnapshot` used by each run and
  formats skill metadata/content for progressive loading.
- Agent Server separately binds trusted skills to already registered tool
  capabilities; loading instructions never grants permission by itself.

Open the skill manager with `/skills` in chat or from Settings. Local folders
and Git repositories are supported. Every install is a two-step operation:
preview first, then explicit confirmation. A native Pi `SKILL.md` does not need
MonAgent-specific metadata. The installer rejects symbolic
links, invalid names, unknown tools, oversized packages and unsafe subpaths.

User skills are stored under
`~/.pi/agent/skills/monagent/<user-key>/`; project skills are stored under
`<workspace>/.pi/skills/monagent/<user-key>/`. Core records and physical files
are updated with rollback protection.

A skill uses AgentCore's normal frontmatter and may add MonAgent metadata:

```markdown
---
name: web-briefing
description: Research current information and prepare a concise briefing.
metadata:
  monagent:
    display_name: 网页简报
    version: 1.0.0
    tools: [web_search, web_fetch]
    profiles: [user_chat]
---
Search only when current information is required and identify the sources used.
```

The model sees only skill metadata until it calls `load_skill`; the complete
instructions are then loaded from the run's resource snapshot. Optional
`tools` entries are host capability bindings and must name tools already
registered by MonAgent. They are not part of the portable skill resource and
do not grant permission: write and command tools continue through the normal
permission broker. `profiles` accepts `user_chat` and `self_awake`.

## External Email

External email is owned by Core and MonOs, not by this Agent server.

- Core stores the user mailbox configuration.
- MonOs `Email` performs SMTP delivery.
- MonMcp exposes `email_status` and `email_send`.
- MonAgent only registers conversation tools that call the Core user context.

Use the Core/Web settings page to configure the mailbox. The Agent tool names
are `external_email_status` and `send_external_email`.
