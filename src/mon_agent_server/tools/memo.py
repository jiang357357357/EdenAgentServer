from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from ..agent_api import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .datetime_utils import format_local_datetime, normalize_memo_date
from .memo_format import format_memo_list, memo_line, memo_with_local_time
from .memo_schedule import submit_memo_schedule_refresh
from .result import text_result


def should_auto_complete_triggered_memo(memo: dict[str, Any]) -> bool:
    return (
        isinstance(memo, dict)
        and memo.get("kind") == "reminder"
        and memo.get("status") == "active"
        and not str(memo.get("repeat_rule") or "").strip()
    )


def create_memo_tools(workspace_root: Path, context: MonToolContext) -> list[AgentTool]:
    async def create_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(
            core_call,
            core.create_memo,
            token,
            {
                "title": params["title"],
                "content": params.get("content") or "",
                "kind": params.get("kind") or "note",
                "priority": params.get("priority") or "normal",
                "remind_at": normalize_memo_date(params.get("remind_at"), "remind_at"),
                "due_at": normalize_memo_date(params.get("due_at"), "due_at"),
                "repeat_rule": params.get("repeat_rule") or "",
                "source": "monagent",
                "related_session_id": context.session_id or "",
                "metadata": params.get("metadata") or {},
            },
        )
        submit_memo_schedule_refresh(workspace_root, reason="memo_created", memo=memo)
        return text_result(f"已创建备忘录。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def create_reminder_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(
            core_call,
            core.create_memo,
            token,
            {
                "title": params["title"],
                "content": params.get("content") or "",
                "kind": "reminder",
                "priority": params.get("priority") or "normal",
                "remind_at": normalize_memo_date(params.get("remind_at"), "remind_at"),
                "source": "monagent",
                "related_session_id": context.session_id or "",
                "metadata": params.get("metadata") or {},
            },
        )
        submit_memo_schedule_refresh(workspace_root, reason="reminder_created", memo=memo)
        return text_result(f"已创建提醒。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def list_memos_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memos = await asyncio.to_thread(
            core_call,
            core.list_memos,
            token,
            {
                "kind": params.get("kind"),
                "status": params.get("status"),
                "priority": params.get("priority"),
                "q": params.get("q"),
                "limit": min(max(int(params.get("limit") or 20), 1), 100),
            },
        )
        return text_result(format_memo_list("备忘录查询结果：", memos), {"memos": [memo_with_local_time(memo) for memo in memos], "count": len(memos)})

    async def list_due_memos_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memos = await asyncio.to_thread(
            core_call,
            core.list_due_memos,
            token,
            {
                "before": normalize_memo_date(params.get("before"), "before"),
                "limit": min(max(int(params.get("limit") or 20), 1), 100),
            },
        )
        return text_result(format_memo_list("到期提醒：", memos), {"memos": [memo_with_local_time(memo) for memo in memos], "count": len(memos)})

    async def dispatch_due_memos_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        result = await asyncio.to_thread(
            core_call,
            core.dispatch_due_memos,
            token,
            {
                "before": normalize_memo_date(params.get("before"), "before"),
                "limit": min(max(int(params.get("limit") or 20), 1), 100),
                "mark_dispatched": bool(params.get("mark_dispatched")),
            },
        )
        if result.get("mark_dispatched"):
            submit_memo_schedule_refresh(workspace_root, reason="memos_dispatched")
        body = "\n\n".join(
            [
                format_memo_list("到期派发结果：", result.get("memos") or []),
                f"派发数量: {result.get('dispatched_count')}",
                f"已标记派发: {'是' if result.get('mark_dispatched') else '否'}",
                f"下一次唤醒（本地时间）: {format_local_datetime(result.get('next_wake_at'))}",
            ]
        )
        return text_result(body, result)

    async def get_next_memo_wake_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        result = await asyncio.to_thread(core_call, core.get_next_memo_wake, token, normalize_memo_date(params.get("after"), "after"))
        memo = result.get("memo") if isinstance(result, dict) else None
        body = (
            f"下一次提醒唤醒（本地时间）: {format_local_datetime(result.get('next_wake_at'))}\n\n{memo_line(memo)}"
            if memo
            else "当前没有需要安排唤醒的提醒/待办。"
        )
        return text_result(body, result if isinstance(result, dict) else {})

    async def complete_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(core_call, core.complete_memo, token, int(params["id"]))
        submit_memo_schedule_refresh(workspace_root, reason="memo_completed", memo=memo)
        return text_result(f"已完成备忘录。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def archive_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(core_call, core.update_memo, token, int(params["id"]), {"status": "archived"})
        submit_memo_schedule_refresh(workspace_root, reason="memo_archived", memo=memo)
        return text_result(f"已归档备忘录。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def snooze_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(
            core_call,
            core.snooze_memo,
            token,
            int(params["id"]),
            {"until": normalize_memo_date(params.get("until"), "until"), "minutes": params.get("minutes")},
        )
        submit_memo_schedule_refresh(workspace_root, reason="memo_snoozed", memo=memo)
        return text_result(f"已设置稍后提醒。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def mark_memo_triggered_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(core_call, core.mark_memo_triggered, token, int(params["id"]))
        auto_complete = params.get("auto_complete_once_reminder", True) is not False
        completed_memo = None
        if auto_complete and should_auto_complete_triggered_memo(memo):
            completed_memo = await asyncio.to_thread(core_call, core.complete_memo, token, int(params["id"]))
            memo = completed_memo
        submit_memo_schedule_refresh(workspace_root, reason="memo_triggered", memo=memo)
        action_text = "已标记提醒触发，并完成一次性提醒。" if completed_memo else "已标记提醒触发。"
        return text_result(
            f"{action_text}\n\n{memo_line(memo)}",
            {
                "memo": memo_with_local_time(memo),
                "auto_completed": bool(completed_memo),
            },
        )

    mark_triggered_schema = {
        "type": "object",
        "properties": {
            "id": {"type": "number"},
            "auto_complete_once_reminder": {
                "type": "boolean",
                "description": "默认 true。普通一次性提醒触发后自动完成；待办和重复提醒不会自动完成。",
            },
        },
        "required": ["id"],
    }

    memo_common = {
        "title": {"type": "string", "description": "简短标题。"},
        "content": {"type": "string", "description": "详细内容。"},
        "kind": {"type": "string", "description": "类型：note、reminder 或 todo。"},
        "priority": {"type": "string", "description": "优先级：low、normal 或 high。"},
        "remind_at": {"type": "string", "description": "提醒时间。"},
        "due_at": {"type": "string", "description": "截止时间。"},
        "repeat_rule": {"type": "string", "description": "重复规则。"},
        "metadata": {"type": "object", "description": "扩展数据。"},
    }
    return [
        AgentTool("create_memo", "创建备忘录", "在 MonCore 创建一条用户备忘录、待办或提醒。", {"type": "object", "properties": memo_common, "required": ["title"]}, create_memo_execute, execution_mode="sequential"),
        AgentTool("create_reminder", "创建提醒", "在 MonCore 创建一条会在指定时间触发的提醒。", {"type": "object", "properties": {"title": memo_common["title"], "remind_at": memo_common["remind_at"], "content": memo_common["content"], "priority": memo_common["priority"], "metadata": memo_common["metadata"]}, "required": ["title", "remind_at"]}, create_reminder_execute, execution_mode="sequential"),
        AgentTool("list_memos", "查询备忘录", "查询当前用户的备忘录、提醒和待办。", {"type": "object", "properties": {"kind": {"type": "string"}, "status": {"type": "string"}, "priority": {"type": "string"}, "q": {"type": "string"}, "limit": {"type": "number"}}}, list_memos_execute),
        AgentTool("list_due_memos", "查询到期提醒", "查询当前时间之前应触发但尚未标记触发的提醒/待办。", {"type": "object", "properties": {"before": {"type": "string"}, "limit": {"type": "number"}}}, list_due_memos_execute),
        AgentTool("dispatch_due_memos", "派发到期提醒", "取出已到期且尚未派发的提醒/待办，并返回下一次应唤醒时间。", {"type": "object", "properties": {"before": {"type": "string"}, "limit": {"type": "number"}, "mark_dispatched": {"type": "boolean"}}}, dispatch_due_memos_execute, execution_mode="sequential"),
        AgentTool("get_next_memo_wake", "获取下一次提醒唤醒", "获取下一条未派发提醒/待办的触发时间。", {"type": "object", "properties": {"after": {"type": "string"}}}, get_next_memo_wake_execute),
        AgentTool("complete_memo", "完成备忘录", "将一条备忘录、提醒或待办标记为已完成。", {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]}, complete_memo_execute, execution_mode="sequential"),
        AgentTool("archive_memo", "归档备忘录", "将一条备忘录、提醒或待办归档，用于清理已经处理完但不需要显示在进行中/已完成列表里的事项。", {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]}, archive_memo_execute, execution_mode="sequential"),
        AgentTool("snooze_memo", "稍后提醒", "把一条备忘录/提醒推迟到稍后再次触发。", {"type": "object", "properties": {"id": {"type": "number"}, "until": {"type": "string"}, "minutes": {"type": "number"}}, "required": ["id"]}, snooze_memo_execute, execution_mode="sequential"),
        AgentTool("mark_memo_triggered", "标记提醒已触发", "将一条到期提醒标记为已触发，避免后台重复提醒。普通一次性提醒会默认自动完成；待办和重复提醒只标记触发。", mark_triggered_schema, mark_memo_triggered_execute, execution_mode="sequential"),
    ]
