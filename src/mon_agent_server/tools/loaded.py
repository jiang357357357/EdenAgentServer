from __future__ import annotations

from typing import Any

from mon_agent_core import AgentTool

from .result import text_result


def create_loaded_tools(tools: list[AgentTool]) -> list[AgentTool]:
    async def loaded_tools_execute(
        _tool_call_id: str,
        _params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        lines = []
        for index, tool in enumerate(tools, start=1):
            execution = f"\n   执行: {tool.execution_mode}" if tool.execution_mode else ""
            lines.append(f"{index}. {tool.name}\n   名称: {tool.label}\n   用途: {tool.description}{execution}")
        return text_result(
            "\n\n".join(lines),
            {"count": len(tools), "tools": [{"name": tool.name, "label": tool.label, "description": tool.description} for tool in tools]},
        )

    return [
        AgentTool(
            name="loaded_tools",
            label="已加载工具",
            description="查看本轮 MonAgent 已注册的工具清单、用途和执行策略。",
            parameters={"type": "object", "properties": {}},
            execute=loaded_tools_execute,
        )
    ]
