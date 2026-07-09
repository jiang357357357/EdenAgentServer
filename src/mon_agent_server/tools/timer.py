from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from ..core import to_storage_iso
from ..ids import now_ms
from .datetime_utils import format_local_datetime
from .result import text_result
from .self_awake_state import resolve_self_awake_state_path, resolve_wake_time


def create_timer_tools(root: Path) -> list[AgentTool]:
    async def set_self_awake_timer_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        timer = resolve_self_awake_state_path(root)
        wake_at, after_minutes = resolve_wake_time(params, timer["min_minutes"], timer["max_minutes"])
        reason = str(params.get("reason") or "Agent 设置下一次自醒时间。").strip()
        state_path: Path = timer["state_path"]
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        state.update(
            {
                "enabled": True,
                "next_wake_at": to_storage_iso(wake_at.timestamp() * 1000),
                "next_wake_after_minutes": after_minutes,
                "next_wake_reason": reason,
                "last_timer_tool_at": to_storage_iso(now_ms()),
                "last_timer_tool_source": "monagent",
            }
        )
        tmp_path = state_path.with_suffix(f"{state_path.suffix}.tmp")
        tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(state_path)
        return text_result(
            "\n".join(["已调用 MonOs 自醒定时器。", f"下次自醒（本地时间）: {format_local_datetime(wake_at)}", f"间隔: {after_minutes} 分钟", f"原因: {reason}"]),
            {"next_wake_at": state["next_wake_at"], "next_wake_at_local": format_local_datetime(wake_at), "after_minutes": after_minutes, "reason": reason, "state_path": str(state_path)},
        )

    return [
        AgentTool(
            "set_self_awake_timer",
            "设置自醒定时器",
            "调用 MonOs 自醒定时器，设置下一次后台自醒时间。",
            {"type": "object", "properties": {"after_minutes": {"type": "number"}, "at": {"type": "string"}, "reason": {"type": "string"}}},
            set_self_awake_timer_execute,
            execution_mode="sequential",
        )
    ]
