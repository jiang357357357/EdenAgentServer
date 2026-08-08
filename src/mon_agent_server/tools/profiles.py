from __future__ import annotations

from typing import Any


SELF_AWAKE_ALLOWED_TOOLS = {
    "loaded_tools",
    "get_self_awake_state",
    "list_self_awake_diaries",
    "read_self_awake_diary",
    "web",
    "get_calendar_context",
    "get_weather",
    "analyze_image",
    "analyze_screen",
    "capture_camera",
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
    "external_email_status",
    "qq_bot_list",
    "qq_bot_targets",
    "read_qq_messages",
    "send_qq_message",
    "send_external_email",
    "contact_user",
    "list_connectors",
    "register_connector",
    "set_connector_state",
    "claim_connector_events",
    "finish_connector_events",
    "execute_connector_action",
    "query_openttd",
    "read",
    "ls",
    "grep",
    "find",
    "create_skill",
    "list_skills",
}


def allowed_tool_names(profile: str, tools: list[Any], coding_tools: dict[str, Any]) -> set[str]:
    if profile == "self_awake":
        return set(SELF_AWAKE_ALLOWED_TOOLS)
    return {tool.name for tool in tools} | set(coding_tools.keys())
