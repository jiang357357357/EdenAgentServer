from __future__ import annotations

from typing import Any


def message_text(message: dict[str, Any]) -> str:
    return "\n".join(part.get("text", "") for part in message.get("parts", []) if part.get("type") == "text").strip()


def message_compaction(message: dict[str, Any]) -> dict[str, Any] | None:
    info = message.get("info", {})
    for part in message.get("parts", []):
        if part.get("type") != "compaction":
            continue
        summary = str(part.get("summary") or part.get("text") or "").strip()
        if not summary:
            return None
        return {
            "role": "compactionSummary",
            "summary": summary,
            "tokensBefore": int(part.get("tokensBefore") or part.get("tokens_before") or 0),
            "timestamp": info.get("time", {}).get("created"),
            "firstKeptEntryId": part.get("firstKeptEntryId") or part.get("tail_start_id"),
            "details": part.get("details"),
        }
    return None


def is_hidden_message(message: dict[str, Any]) -> bool:
    return bool(message.get("info", {}).get("hidden"))


