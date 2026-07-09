from __future__ import annotations

from typing import Any


def final_assistant_text(messages: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip():
                blocks.append(str(part.get("text") or "").strip())
    return blocks[-1] if blocks else ""


def final_assistant_usage(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        input_tokens = int(usage.get("input") or 0)
        cache_read = int(usage.get("cacheRead") or 0)
        cache_miss = int(usage.get("cacheMiss") or max(input_tokens - cache_read, 0))
        return {
            "input": input_tokens,
            "output": int(usage.get("output") or 0),
            "cacheRead": cache_read,
            "cacheMiss": cache_miss,
            "cacheWrite": int(usage.get("cacheWrite") or 0),
            "totalTokens": int(usage.get("totalTokens") or 0),
        }
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheMiss": 0, "cacheWrite": 0, "totalTokens": 0}


def request_character(request: dict[str, Any], core: dict[str, Any] | None) -> dict[str, Any]:
    character = (core or {}).get("character")
    if isinstance(character, dict):
        return character
    character = request.get("character")
    return character if isinstance(character, dict) else {}
