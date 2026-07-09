from __future__ import annotations

from datetime import datetime
from typing import Any

from ..core import to_storage_iso


def format_local_datetime(value: Any) -> str:
    if not value:
        return "-"
    if isinstance(value, (int, float)):
        dt = datetime.fromtimestamp(value / 1000).astimezone()
    elif isinstance(value, datetime):
        dt = value
    else:
        raw = str(value).strip()
        if not raw:
            return "-"
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return raw
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def to_local_iso(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        return value
    return parsed.astimezone().isoformat()


def parse_local_datetime(value: str) -> datetime:
    raw = value.strip()
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return parsed


def normalize_memo_date(value: Any, field: str) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是日期时间字符串。")
    try:
        return to_storage_iso(parse_local_datetime(value).timestamp() * 1000)
    except ValueError as error:
        raise ValueError(f"无法解析 {field}: {value}") from error
