from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from ...ids import now_ms
from ...model_stream import stream_openai_compatible


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def runtime_compaction_settings() -> dict[str, Any]:
    defaults = {"enabled": True, "reserveTokens": 16_384, "keepRecentTokens": 8_000, "tailTurns": 2}
    configured_keep_recent = os.environ.get("MON_AGENT_COMPACTION_KEEP_RECENT_TOKENS")
    return {
        "enabled": _env_bool("MON_AGENT_COMPACTION_ENABLED", bool(defaults["enabled"])),
        "reserveTokens": _env_int("MON_AGENT_COMPACTION_RESERVE_TOKENS", int(defaults["reserveTokens"])),
        "keepRecentTokens": (
            _env_int("MON_AGENT_COMPACTION_KEEP_RECENT_TOKENS", int(defaults["keepRecentTokens"]))
            if configured_keep_recent is not None
            else None
        ),
        "tailTurns": _env_int("MON_AGENT_COMPACTION_TAIL_TURNS", int(defaults["tailTurns"])),
    }


def timestamp_iso(timestamp: Any) -> str:
    if isinstance(timestamp, str):
        try:
            return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().isoformat()
        except ValueError:
            pass
    try:
        value = float(timestamp) / 1000
        moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=value)
    except (TypeError, ValueError, OverflowError):
        value = now_ms() / 1000
        moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=value)
    return moment.astimezone().isoformat()


def messages_to_compaction_entries(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    previous_id: str | None = None
    entry_ids = [f"runtime_{index:06d}" for index, _message in enumerate(messages)]
    for index, message in enumerate(messages):
        entry_id = entry_ids[index]
        if message.get("role") == "compactionSummary":
            next_id = entry_ids[index + 1] if index + 1 < len(entry_ids) else entry_id
            entry = {
                "type": "compaction",
                "id": entry_id,
                "parentId": previous_id,
                "timestamp": timestamp_iso(message.get("timestamp")),
                "summary": str(message.get("summary") or ""),
                "tokensBefore": int(message.get("tokensBefore") or 0),
                "firstKeptEntryId": message.get("firstKeptEntryId") or next_id,
                "details": message.get("details"),
            }
        else:
            entry = {
                "type": "message",
                "id": entry_id,
                "parentId": previous_id,
                "timestamp": timestamp_iso(message.get("timestamp")),
                "message": message,
            }
        entries.append(entry)
        previous_id = entry_id
    return entries


class RuntimeCompactionModels:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    async def complete_simple(self, model: dict[str, Any], context: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        stream = await stream_openai_compatible(model, context, {"apiKey": self.api_key, **(options or {})})
        return await stream.result()
