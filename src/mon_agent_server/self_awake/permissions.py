from __future__ import annotations

from typing import Any

from ..logging import get_logger

logger = get_logger("MonAgent", "SelfAwake")


def has_meaningful_array(value: Any) -> bool:
    return isinstance(value, list) and any(str(item or "").strip() for item in value)


def self_awake_can_use_file_tool(context: dict[str, Any] | None, tool_name: str, args: Any) -> bool:
    if tool_name not in {"read", "ls", "grep", "find"}:
        return False
    data = context or {}
    if data.get("debug_target") or data.get("debugTarget"):
        return True
    if has_meaningful_array(data.get("recent_incidents")) or has_meaningful_array(data.get("recent_logs")):
        return True
    policy = data.get("policy") if isinstance(data.get("policy"), dict) else {}
    if policy.get("allow_workspace_file_tools") is True:
        return True
    if isinstance(args, dict):
        path_value = args.get("path")
        pattern_value = args.get("pattern")
        if isinstance(path_value, str) and path_value not in {"", ".", "./"} and isinstance(pattern_value, str) and pattern_value:
            return True
    return False


def tool_pattern(tool_name: str, args: Any) -> str:
    if isinstance(args, dict):
        for key in ["path", "url", "query", "command"]:
            value = args.get(key)
            if isinstance(value, str) and value:
                return value
    return tool_name


def self_awake_before_tool_call(context_data: dict[str, Any] | None):
    allowed_tools = {
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
    }
    file_tools = {"read", "ls", "grep", "find"}

    async def before_tool_call(context: dict[str, Any], _signal: Any = None) -> dict[str, Any] | None:
        tool_call = context.get("toolCall") or {}
        tool_name = str(tool_call.get("name") or "")
        args = context.get("args")
        pattern = tool_pattern(tool_name, args)
        if self_awake_can_use_file_tool(context_data, tool_name, args):
            logger.info(f"文件工具已按上下文放行: {tool_name} {pattern}")
            return None
        if tool_name in file_tools:
            logger.warning(f"文件工具已拦截: {tool_name} {pattern}")
            return {
                "block": True,
                "reason": "当前自醒上下文已提供工作区与工作日记摘要，后台自醒不能无目的浏览文件。只有存在 debug_target、recent_incidents 或明确错误日志时才可读取具体文件。",
            }
        if tool_name in allowed_tools:
            logger.info(f"工具已允许: {tool_name} {pattern}")
            return None
        logger.warning(f"后台工具已拦截: {tool_name} {pattern}")
        return {
            "block": True,
            "reason": "当前轮次是后台非交互观察，不能直接执行需要用户确认或可能产生副作用的工具。请在最终 JSON 的 action 字段中说明需要的动作。",
        }

    return before_tool_call
