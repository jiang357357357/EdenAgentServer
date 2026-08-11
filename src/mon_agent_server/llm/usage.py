from __future__ import annotations

from typing import Any

from mon_agent_core.types import now_ms

from .tools import parse_tool_arguments


def usage_from_openai(usage: dict[str, Any] | None) -> dict[str, Any]:
    usage = usage or {}
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    prompt_details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
    cached_tokens = int(prompt_details.get("cached_tokens") or usage.get("cached_tokens") or 0)
    # OpenAI reports cached tokens as a subset of prompt_tokens. A few compatible
    # providers still report only the cache miss in prompt_tokens; that shape is
    # identifiable when cached_tokens is larger than prompt_tokens.
    cache_is_included = cached_tokens <= prompt_tokens
    input_tokens = prompt_tokens if cache_is_included else prompt_tokens + cached_tokens
    cache_miss_tokens = max(0, prompt_tokens - cached_tokens) if cache_is_included else prompt_tokens
    total_tokens = int(usage.get("total_tokens") or 0) or input_tokens + completion_tokens
    return {
        "input": input_tokens,
        "output": completion_tokens,
        "cacheRead": cached_tokens,
        "cacheMiss": cache_miss_tokens,
        "cacheWrite": 0,
        "totalTokens": total_tokens,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    }


def base_assistant_message(model: dict[str, Any], content: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": content or [],
        "api": model.get("api", "openai-completions"),
        "provider": model.get("provider", "openai"),
        "model": model.get("id", "unknown"),
        "usage": usage_from_openai(None),
        "stopReason": "stop",
        "timestamp": now_ms(),
    }


def assistant_message_from_response(model: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    choice = (response.get("choices") or [{}])[0]
    raw_message = choice.get("message") or {}
    content_blocks: list[dict[str, Any]] = []
    reasoning_field = next(
        (
            field
            for field in ("reasoning_content", "reasoning", "reasoning_text")
            if isinstance(raw_message.get(field), str) and raw_message.get(field)
        ),
        None,
    )
    if reasoning_field:
        signature = "reasoning_content" if model.get("provider") == "opencode-go" and reasoning_field == "reasoning" else reasoning_field
        content_blocks.append(
            {
                "type": "thinking",
                "thinking": raw_message[reasoning_field],
                "thinkingSignature": signature,
            }
        )
    text = raw_message.get("content")
    if isinstance(text, str) and text:
        content_blocks.append({"type": "text", "text": text})
    for call in raw_message.get("tool_calls") or []:
        function = call.get("function") or {}
        content_blocks.append(
            {
                "type": "toolCall",
                "id": call.get("id") or f"call_{now_ms()}",
                "name": function.get("name") or "unknown_tool",
                "arguments": parse_tool_arguments(function.get("arguments")),
            }
        )
    finish_reason = choice.get("finish_reason") or "stop"
    message = base_assistant_message(model, content_blocks or [{"type": "text", "text": ""}])
    message["usage"] = usage_from_openai(response.get("usage"))
    message["stopReason"] = "tool_calls" if finish_reason == "tool_calls" else finish_reason
    return message
