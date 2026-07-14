from __future__ import annotations

from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from ..core import to_storage_iso
from ..ids import create_id, now_ms
from .datetime_utils import format_local_datetime
from .result import text_result
from .self_awake_state import resolve_self_awake_state_path, resolve_wake_time


def create_timer_tools(root: Path) -> list[AgentTool]:
    async def set_self_awake_timer_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        timer = resolve_self_awake_state_path(root)
        wake_at, after_minutes = resolve_wake_time(params, timer["min_minutes"], timer["max_minutes"])
        reason = str(params.get("reason") or "Agent 设置下一次自醒时间。").strip()
        request_id = create_id("selfawakeschedule")
        request_dir: Path = timer["request_dir"]
        request_dir.mkdir(parents=True, exist_ok=True)
        request = {
            "request_id": request_id,
            "requested_at": to_storage_iso(now_ms()),
            "requested_by": "monagent",
            "next_wake_at": to_storage_iso(wake_at.timestamp() * 1000),
            "after_minutes": after_minutes,
            "reason": reason,
        }
        request_path = request_dir / f"{request_id}.json"
        tmp_path = request_path.with_suffix(".json.tmp")
        import json

        tmp_path.write_text(json.dumps(request, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(request_path)
        return text_result(
            "\n".join(["已向 MonOs 提交自醒调度请求。", f"计划时间（本地时间）: {format_local_datetime(wake_at)}", f"间隔: {after_minutes} 分钟", f"原因: {reason}"]),
            {
                "request_id": request_id,
                "status": "submitted",
                "next_wake_at": request["next_wake_at"],
                "next_wake_at_local": format_local_datetime(wake_at),
                "after_minutes": after_minutes,
                "reason": reason,
            },
        )

    return [
        AgentTool(
            "set_self_awake_timer",
            "设置自醒定时器",
            "向 MonOs 提交下一次后台自醒时间；MonOs 是唯一调度状态写入者。",
            {"type": "object", "properties": {"after_minutes": {"type": "number"}, "at": {"type": "string"}, "reason": {"type": "string"}}},
            set_self_awake_timer_execute,
            execution_mode="sequential",
        )
    ]
