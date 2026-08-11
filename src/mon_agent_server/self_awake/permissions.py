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


def memo_due_notification_args(context_data: dict[str, Any] | None) -> dict[str, Any] | None:
    data = context_data or {}
    event = data.get("event") if isinstance(data.get("event"), dict) else {}
    if str(event.get("reason") or data.get("trigger") or "").strip().lower() != "memo_due":
        return None
    raw_memos = data.get("due_memos") if isinstance(data.get("due_memos"), list) else []
    memos = [memo for memo in raw_memos if isinstance(memo, dict)]
    if not memos and isinstance(data.get("memo"), dict):
        memos = [data["memo"]]
    if not memos:
        return None
    primary = memos[0]
    titles = [str(memo.get("title") or f"备忘录 #{memo.get('id')}").strip() for memo in memos]
    lines = [
        f"· {title}：{str(memo.get('content') or '已到设定的提醒时间。').strip()}"
        for memo, title in zip(memos, titles)
    ]
    return {
        "title": f"提醒：{titles[0]}" if len(titles) == 1 else f"{len(titles)} 项提醒已到时间",
        "message": "\n".join(lines),
        "channel": "auto",
        "source_type": "memo",
        "source_id": str(primary.get("id") or ""),
        "metadata": {"memo_ids": [memo.get("id") for memo in memos if memo.get("id") is not None]},
    }


def is_memo_due_context(context_data: dict[str, Any] | None) -> bool:
    data = context_data or {}
    event = data.get("event") if isinstance(data.get("event"), dict) else {}
    return str(event.get("reason") or data.get("trigger") or "").strip().lower() == "memo_due"


def self_awake_before_tool_call(context_data: dict[str, Any] | None):
    notification_calls = 0
    allowed_tools = {
        "load_skill",
        "activate_skill",
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
        "create_skill",
        "update_skill",
        "list_skills",
        "list_connectors",
        "register_connector",
        "set_connector_state",
        "claim_connector_events",
        "finish_connector_events",
        "execute_connector_action",
    }
    file_tools = {"read", "ls", "grep", "find"}

    async def before_tool_call(context: dict[str, Any], _signal: Any = None) -> dict[str, Any] | None:
        nonlocal notification_calls
        tool_call = context.get("toolCall") or {}
        tool_name = str(tool_call.get("name") or "")
        args = context.get("args")
        pattern = tool_pattern(tool_name, args)
        if tool_name == "dispatch_due_memos" and isinstance(args, dict):
            args["mark_dispatched"] = False
        if is_memo_due_context(context_data) and tool_name in {
            "mark_memo_triggered",
            "complete_memo",
            "archive_memo",
            "snooze_memo",
        }:
            logger.info("memo_due 状态回写已交给通知成功后的运行时收尾: %s", tool_name)
            return {
                "block": True,
                "reason": "精准提醒的状态只能在通知真实成功后由运行时统一回写；本轮不要直接修改该提醒。",
            }
        if tool_name in {"contact_user", "send_qq_message", "send_external_email"}:
            forced_memo_args = memo_due_notification_args(context_data)
            if forced_memo_args and tool_name != "contact_user":
                return {
                    "block": True,
                    "reason": "精准到期提醒必须通过 contact_user 联系当前用户，不能改发给其他目标。",
                }
            if forced_memo_args and isinstance(args, dict):
                args.clear()
                args.update(forced_memo_args)
                logger.info("已将 memo_due 通知参数固定为唤醒任务内容")
            if notification_calls >= 1:
                logger.warning("本轮重复通知已拦截")
                return {
                    "block": True,
                    "reason": "每次后台自醒只能执行一次对外联系；首次调用已经完成发送或通道回退，不能在同一轮重复联系。",
                }
            notification_calls += 1
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
