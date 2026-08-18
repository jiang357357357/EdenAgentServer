from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

import tiktoken


@lru_cache(maxsize=64)
def encoding_for_model(model_id: str | None = None):
    normalized = str(model_id or "").strip().rsplit("/", 1)[-1]
    if normalized:
        try:
            return tiktoken.encoding_for_model(normalized)
        except KeyError:
            pass
    return tiktoken.get_encoding("o200k_base")


def tokenizer_name(model_id: str | None = None) -> str:
    return encoding_for_model(model_id).name


def count_text_tokens(text: Any, model_id: str | None = None) -> int:
    value = str(text or "")
    return len(encoding_for_model(model_id).encode(value, disallowed_special=())) if value else 0


def count_json_tokens(value: Any, model_id: str | None = None) -> int:
    return count_text_tokens(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str), model_id)


def _content_tokens(content: Any, model_id: str | None = None) -> int:
    if isinstance(content, str):
        return count_text_tokens(content, model_id)
    if not isinstance(content, list):
        return 0
    return sum(
        count_text_tokens(block.get("text", ""), model_id) if block.get("type") == "text" else 1_200 if block.get("type") == "image" else 0
        for block in content if isinstance(block, dict)
    )


def estimate_tokens(message: dict[str, Any], model_id: str | None = None) -> int:
    role = message.get("role")
    if role == "user":
        return _content_tokens(message.get("content", ""), model_id)
    if role == "assistant":
        total = 0
        for block in message.get("content") or []:
            if block.get("type") == "text":
                total += count_text_tokens(block.get("text", ""), model_id)
            elif block.get("type") == "thinking":
                total += count_text_tokens(block.get("thinking", ""), model_id)
            elif block.get("type") == "toolCall":
                total += count_text_tokens(block.get("name", ""), model_id)
                total += count_json_tokens(block.get("arguments", {}), model_id)
        return total
    if role in {"custom", "toolResult"}:
        total = _content_tokens(message.get("content", ""), model_id)
        if role == "toolResult" and message.get("structuredContent") is not None:
            total += count_json_tokens(message["structuredContent"], model_id)
        return total
    if role == "bashExecution":
        return count_text_tokens(message.get("command", ""), model_id) + count_text_tokens(message.get("output", ""), model_id)
    if role in {"branchSummary", "compactionSummary"}:
        return count_text_tokens(message.get("summary", ""), model_id)
    return 0


def _usage_tokens(message: dict[str, Any]) -> int:
    if message.get("role") != "assistant" or message.get("stopReason") in {"error", "aborted"}:
        return 0
    usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
    return int(usage.get("totalTokens") or sum(int(usage.get(key) or 0) for key in ("input", "output", "cacheRead", "cacheWrite")))


def estimate_context_tokens(messages: list[dict[str, Any]], model_id: str | None = None) -> dict[str, Any]:
    for index in range(len(messages) - 1, -1, -1):
        usage_tokens = _usage_tokens(messages[index])
        if usage_tokens:
            trailing = sum(estimate_tokens(message, model_id) for message in messages[index + 1:])
            return {"tokens": usage_tokens + trailing, "usageTokens": usage_tokens, "trailingTokens": trailing, "lastUsageIndex": index}
    estimated = sum(estimate_tokens(message, model_id) for message in messages)
    return {"tokens": estimated, "usageTokens": 0, "trailingTokens": estimated, "lastUsageIndex": None}
