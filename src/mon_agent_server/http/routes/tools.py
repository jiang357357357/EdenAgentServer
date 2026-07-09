from __future__ import annotations

from typing import Any

from ...tools import MonToolContext, create_mon_agent_tools


def handle_tools(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if method != "GET" or path != "/tools/status":
        return False
    tool_names = [tool.name for tool in create_mon_agent_tools(handler.app.config.workspace_root, MonToolContext(), "user_chat")]
    handler.json_response(
        {
            "search": {
                "status": "online",
                "provider": "python-agent-core",
                "mode": "embedded",
                "label": "Python AgentCore",
                "message": "Python Agent Server 已启动；当前内置 Mon 工具、日历工具、天气工具、备忘录工具、自醒工具和 Python AgentCore 文件工具。",
            },
            "tools": {name: name for name in tool_names},
        }
    )
    return True
