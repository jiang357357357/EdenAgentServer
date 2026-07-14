from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .datetime_utils import parse_local_datetime


def find_mon_root(workspace_root: Path | str) -> Path:
    current = Path(workspace_root).resolve()
    for _ in range(8):
        if (current / "Backend" / "BaseOs" / ".monconfig").exists():
            return current
        if current.parent == current:
            break
        current = current.parent
    raise RuntimeError(f"无法从工作区定位 Mon 根目录: {workspace_root}")


def read_ini_value(content: str, section: str, key: str) -> str | None:
    current_section = ""
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_section = line[1:-1].strip()
            continue
        if current_section == section and "=" in line:
            raw_key, raw_value = line.split("=", 1)
            if raw_key.strip() == key:
                return raw_value.strip()
    return None


def resolve_self_awake_state_path(workspace_root: Path | str) -> dict[str, Any]:
    mon_root = find_mon_root(workspace_root)
    base_os_root = mon_root / "Backend" / "BaseOs"
    config_path = base_os_root / ".monconfig"
    content = config_path.read_text(encoding="utf-8", errors="replace") if config_path.exists() else ""
    data_dir = read_ini_value(content, "self_awake", "DATA_DIR") or "Data/SelfAwake"
    data_path = Path(data_dir)
    state_path = data_path if data_path.suffix == ".json" else data_path / "state.json"
    if not state_path.is_absolute():
        state_path = base_os_root / state_path
    return {
        "state_path": state_path,
        "request_dir": state_path.parent / "schedule_requests",
        "min_minutes": int(read_ini_value(content, "self_awake", "MIN_WAKE_MINUTES") or 1),
        "max_minutes": int(read_ini_value(content, "self_awake", "MAX_WAKE_MINUTES") or 1440),
    }


def resolve_wake_time(input_value: dict[str, Any], min_minutes: int, max_minutes: int) -> tuple[datetime, int]:
    current = datetime.now().astimezone()
    if input_value.get("at"):
        target = parse_local_datetime(str(input_value["at"]))
        after_minutes = int((target - current).total_seconds() // 60)
        if after_minutes < min_minutes:
            raise ValueError(f"自醒时间过近，至少需要 {min_minutes} 分钟后。")
        if after_minutes > max_minutes:
            raise ValueError(f"自醒时间过远，最多允许 {max_minutes} 分钟后。")
        return target, after_minutes
    raw_minutes = int(round(float(input_value.get("after_minutes") or 720)))
    after_minutes = min(max(raw_minutes, min_minutes), max_minutes)
    return current + timedelta(minutes=after_minutes), after_minutes
