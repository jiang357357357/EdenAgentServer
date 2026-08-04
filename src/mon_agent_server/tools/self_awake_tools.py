from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .datetime_utils import format_local_datetime
from .memo_format import self_awake_diary_line, self_awake_diary_summary
from .result import text_result, truncate
from .self_awake_state import resolve_self_awake_state_path


def create_self_awake_tools(root: Path, context: MonToolContext) -> list[AgentTool]:
    async def get_self_awake_state_execute(_tool_call_id: str, _params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        timer = resolve_self_awake_state_path(root)
        state_path: Path = timer["state_path"]
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        if not isinstance(state, dict):
            state = {}
        details = {
            **state,
            "state_path": str(state_path),
            "min_minutes": timer["min_minutes"],
            "max_minutes": timer["max_minutes"],
            "next_wake_at_local": format_local_datetime(state.get("next_wake_at")),
            "last_timer_tool_at_local": format_local_datetime(state.get("last_timer_tool_at")),
        }
        body = "\n".join(
            [
                "MonOs 自醒状态：",
                f"启用: {'是' if state.get('enabled') else '否'}",
                f"下次醒来（本地时间）: {details['next_wake_at_local']}",
                f"间隔: {state.get('next_wake_after_minutes') or '-'} 分钟",
                f"原因: {state.get('next_wake_reason') or '-'}",
                f"最近设置来源: {state.get('last_timer_tool_source') or '-'}",
                f"最近设置时间: {details['last_timer_tool_at_local']}",
                f"状态文件: {state_path}",
                f"允许范围: {timer['min_minutes']} 到 {timer['max_minutes']} 分钟",
            ]
        )
        return text_result(body, details)

    async def list_self_awake_diaries_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        limit = min(max(int(params.get("limit") or 5), 1), 12)
        raw = await asyncio.to_thread(
            core_call,
            core.get_self_awake_diary_context,
            token,
            limit,
            character_id=(context.character or {}).get("id"),
        )
        recent = raw.get("recent") if isinstance(raw, dict) and isinstance(raw.get("recent"), list) else []
        diaries = [self_awake_diary_summary(item) for item in recent if isinstance(item, dict)]
        memory = raw.get("memory") if isinstance(raw, dict) and isinstance(raw.get("memory"), dict) else {}
        memory_lines = [
            f"工作记忆: {memory.get('summary') or '-'}",
            "开放线索: " + (", ".join(str(item) for item in memory.get("open_threads") or []) or "-"),
            "避免重复: " + (", ".join(str(item) for item in memory.get("avoid_repeating") or []) or "-"),
        ]
        body = "\n".join(memory_lines) + "\n\n最近工作日记：\n\n" + ("\n\n".join(self_awake_diary_line(item) for item in diaries) if diaries else "暂无工作日记。")
        return text_result(
            body,
            {
                "source": raw.get("source") if isinstance(raw, dict) else "core",
                "limit": limit,
                "memory": memory,
                "last": self_awake_diary_summary(raw["last"]) if isinstance(raw, dict) and isinstance(raw.get("last"), dict) else None,
                "diaries": diaries,
            },
        )

    async def read_self_awake_diary_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        diary_id = int(params["id"])
        diary = await asyncio.to_thread(core_call, core.get_self_awake_diary, token, diary_id)
        body = "\n".join(
            [
                f"工作日记 #{diary.get('id')}",
                f"标题: {diary.get('title') or '-'}",
                f"创建时间: {format_local_datetime(diary.get('created_at'))}",
                f"重要性: {diary.get('importance') or '-'}",
                f"连续性: {diary.get('continuity_key') or '-'}",
                f"标签: {', '.join(str(tag) for tag in diary.get('tags') or []) or '-'}",
                f"摘要: {diary.get('summary') or '-'}",
                "",
                str(diary.get("content") or ""),
            ]
        )
        return text_result(truncate(body, 24_000), {"diary": diary})

    return [
        AgentTool(
            "get_self_awake_state",
            "读取自醒状态",
            "读取 MonOs 自醒 state.json，了解下次唤醒时间、原因和调度范围。",
            {"type": "object", "properties": {}},
            get_self_awake_state_execute,
        ),
        AgentTool(
            "list_self_awake_diaries",
            "列出工作日记",
            "从 Core 查询最近自醒工作日记列表和工作记忆；只返回标题、摘要、标签和连续性线索，不返回完整正文。",
            {
                "type": "object",
                "properties": {
                    "limit": {"type": "number", "description": "返回条数，默认 5，最大 12。"},
                },
            },
            list_self_awake_diaries_execute,
        ),
        AgentTool(
            "read_self_awake_diary",
            "读取工作日记",
            "按日记 id 读取一篇完整自醒工作日记正文；通常先调用 list_self_awake_diaries 再选择需要读取的日记。",
            {
                "type": "object",
                "properties": {
                    "id": {"type": "number", "description": "工作日记 id。"},
                },
                "required": ["id"],
            },
            read_self_awake_diary_execute,
        ),
    ]
