from __future__ import annotations

import math
import random
import string
from datetime import datetime
from typing import Any

from ..ids import now_ms


def to_storage_iso(value: int | float | None = None) -> str:
    millis = now_ms() if value is None else value
    return datetime.fromtimestamp(millis / 1000).astimezone().isoformat()


def unwrap_results(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("results"), list):
        return value["results"]
    return []


def to_millis(value: Any, fallback: int | None = None) -> int:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            normalized = value.replace("Z", "+00:00")
            return int(datetime.fromisoformat(normalized).timestamp() * 1000)
        except ValueError:
            return fallback if fallback is not None else now_ms()
    return fallback if fallback is not None else now_ms()


def is_api_session_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and isinstance(value.get("title"), str)
        and isinstance(value.get("time"), dict)
        and isinstance(value["time"].get("created"), (int, float))
        and isinstance(value["time"].get("updated"), (int, float))
    )


def is_api_message_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("info"), dict)
        and isinstance(value.get("parts"), list)
        and isinstance(value["info"].get("id"), str)
        and value["info"].get("role") in {"user", "assistant"}
    )


def session_from_map(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("session_payload") if is_api_session_payload(item.get("session_payload")) else None
    created = payload["time"]["created"] if payload else to_millis(item.get("created_at"))
    updated = max(
        payload["time"]["updated"] if payload else 0,
        to_millis(item.get("last_message_at"), 0),
        to_millis(item.get("updated_at"), created),
        created,
    )
    return {
        "id": item.get("external_session_id"),
        "title": item.get("title") or (payload or {}).get("title") or "新会话",
        "time": {"created": created, "updated": updated},
    }


def message_from_map(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("message_payload")
    if is_api_message_payload(payload):
        return payload
    created = to_millis(item.get("created_at"))
    return {
        "info": {
            "id": item.get("external_message_id") or f"core_msg_{item.get('id')}",
            "role": "user" if item.get("kind") == "user" else "assistant",
            "time": {"created": created, "completed": to_millis(item.get("updated_at"), created)},
        },
        "parts": [],
    }


def random_suffix(length: int = 6) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(length))


def run_id_from_millis(prefix: str, millis: int) -> str:
    stamp = "".join(char for char in to_storage_iso(millis) if char.isdigit())
    return f"{prefix}-{stamp}-{random_suffix()}"
