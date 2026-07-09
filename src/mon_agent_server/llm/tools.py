from __future__ import annotations

import json
from typing import Any


def tool_payload(tools: list[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for tool in tools:
        output.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": dict(tool.parameters or {"type": "object", "properties": {}}),
                },
            }
        )
    return output


def parse_tool_arguments(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}
