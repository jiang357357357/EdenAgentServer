from __future__ import annotations

from typing import Any

from ...tools import MonToolContext, create_mon_agent_tools


def handle_tools(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if method != "GET" or path != "/tools/status":
        return False
    tools = create_mon_agent_tools(handler.app.config.workspace_root, MonToolContext(), "user_chat")
    tool_names = [tool.name for tool in tools]
    handler.json_response(
        {
            "search": {
                "status": "online",
                "provider": "rust-agent-core",
                "mode": "embedded",
                "label": "Rust AgentCore",
                "message": "Agent Server 已启动；智能体循环由 Rust sidecar 执行，并已加载 Mon 工具、日历、天气、备忘录和自醒能力。",
            },
            "tools": {name: name for name in tool_names},
            "toolDetails": {
                tool.name: {
                    "name": tool.name,
                    "label": tool.label,
                    "description": tool.description,
                    "parameters": dict(tool.parameters),
                    "source": tool.source,
                    "namespace": tool.namespace,
                    "exposure": tool.exposure,
                    "capabilities": sorted(tool.capabilities),
                    "requiresPermission": tool.permission_resolver is not None,
                    "executionMode": tool.execution_mode,
                }
                for tool in tools
            },
        }
    )
    return True
