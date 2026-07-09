from __future__ import annotations

from typing import Any


SELF_AWAKE_ALLOWED_TOOLS = {
    "loaded_tools",
    "get_self_awake_state",
    "list_self_awake_diaries",
    "read_self_awake_diary",
    "web_search",
    "web_fetch",
    "get_calendar_context",
    "get_weather",
    "analyze_image",
    "create_memo",
    "create_reminder",
    "list_memos",
    "list_due_memos",
    "dispatch_due_memos",
    "get_next_memo_wake",
    "complete_memo",
    "archive_memo",
    "snooze_memo",
    "mark_memo_triggered",
    "set_self_awake_timer",
    "external_email_status",
    "send_external_email",
    "qq_bot_list",
    "qq_bot_targets",
    "send_qq_message",
    "notify_user",
    "read",
    "ls",
    "grep",
    "find",
}


def allowed_tool_names(profile: str, tools: list[Any], coding_tools: dict[str, Any]) -> set[str]:
    if profile == "self_awake":
        return set(SELF_AWAKE_ALLOWED_TOOLS)
    return {tool.name for tool in tools} | set(coding_tools.keys())
