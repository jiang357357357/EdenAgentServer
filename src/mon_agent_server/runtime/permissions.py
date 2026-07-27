from __future__ import annotations

from typing import Any


class RuntimePermissionMixin:
    @staticmethod
    def is_safe_tool(tool_name: str) -> bool:
        return tool_name in {
            "load_skill",
            "activate_skill",
            "read",
            "ls",
            "grep",
            "find",
            "external_ls",
            "external_read",
            "external_find",
            "external_grep",
            "web_search",
            "web_fetch",
            "get_self_awake_state",
            "list_self_awake_diaries",
            "read_self_awake_diary",
            "external_email_status",
            "qq_bot_list",
            "qq_bot_targets",
            "loaded_tools",
            "ask_user",
            "analyze_image",
            "analyze_screen",
            "get_calendar_context",
            "get_weather",
            "list_character_actions",
            "switch_character_action",
            "list_memos",
            "list_due_memos",
            "get_next_memo_wake",
            "spawn_agent",
            "send_message",
            "followup_task",
            "list_agents",
            "interrupt_agent",
        }

    @staticmethod
    def permission_pattern(tool_name: str, args: Any) -> str:
        if isinstance(args, dict):
            if tool_name == "apply_patch" and isinstance(args.get("_paths"), list):
                return ", ".join(str(path) for path in args["_paths"])
            for key in ["path", "url", "query", "command"]:
                if isinstance(args.get(key), str):
                    return args[key]
        return tool_name

    @staticmethod
    def permission_always_patterns(tool_name: str) -> list[str]:
        return ["*"] if tool_name in {"web_search", "web_fetch"} else []
