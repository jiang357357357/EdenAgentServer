from __future__ import annotations

from typing import Any


class RuntimePermissionMixin:
    @staticmethod
    def is_safe_tool(tool_name: str) -> bool:
        return tool_name in {
            "read",
            "ls",
            "grep",
            "find",
            "loaded_tools",
            "ask_user",
            "analyze_image",
            "get_calendar_context",
            "get_weather",
            "list_character_actions",
            "switch_character_action",
            "list_memos",
            "list_due_memos",
            "get_next_memo_wake",
        }

    @staticmethod
    def permission_pattern(tool_name: str, args: Any) -> str:
        if isinstance(args, dict):
            for key in ["path", "url", "query", "command"]:
                if isinstance(args.get(key), str):
                    return args[key]
        return tool_name

    @staticmethod
    def permission_always_patterns(tool_name: str) -> list[str]:
        return ["*"] if tool_name in {"web_search", "web_fetch"} else []
