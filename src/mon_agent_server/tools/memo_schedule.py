from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from ..ids import create_id
from ..logging import get_logger
from .self_awake_state import find_mon_root, read_ini_value

logger = get_logger("MonAgent", "MemoSchedule")


def resolve_memo_schedule_request_dir(workspace_root: Path | str) -> Path:
    mon_root = find_mon_root(workspace_root)
    base_os_root = mon_root / "Backend" / "BaseOs"
    config_path = base_os_root / ".monconfig"
    content = (
        config_path.read_text(encoding="utf-8", errors="replace")
        if config_path.exists()
        else ""
    )
    data_dir = Path(read_ini_value(content, "memo", "DATA_DIR") or "Data/MemoScheduler")
    if not data_dir.is_absolute():
        data_dir = base_os_root / data_dir
    return data_dir / "schedule_requests"


def submit_memo_schedule_refresh(
    workspace_root: Path | str,
    *,
    reason: str,
    memo: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Notify MonOs that the authoritative next memo wake must be read from Core again."""
    try:
        request_id = create_id("memoschedule")
        request_dir = resolve_memo_schedule_request_dir(workspace_root)
        request_dir.mkdir(parents=True, exist_ok=True)
        memo_data = memo if isinstance(memo, dict) else {}
        request = {
            "request_id": request_id,
            "requested_at": datetime.now().astimezone().isoformat(),
            "requested_by": "monagent",
            "reason": str(reason or "memo_changed"),
            "memo": {
                key: memo_data.get(key)
                for key in (
                    "id",
                    "title",
                    "kind",
                    "status",
                    "trigger_at",
                    "remind_at",
                    "due_at",
                    "snoozed_until",
                )
                if memo_data.get(key) is not None
            },
        }
        request_path = request_dir / f"{request_id}.json"
        tmp_path = request_path.with_suffix(".json.tmp")
        tmp_path.write_text(
            json.dumps(request, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        tmp_path.replace(request_path)
        return request
    except Exception as error:
        # The Core mutation has already succeeded. Keep the user operation successful;
        # MonOs' reconciliation loop will repair the schedule if this fast path fails.
        logger.warning(f"提交备忘录调度刷新请求失败: {error}")
        return None
