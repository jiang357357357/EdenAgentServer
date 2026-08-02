from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from mon_agent_core import AssistantMessageEventStream
from mon_agent_core.types import now_ms
from .messages import message_content, to_openai_messages
from .models import core_model, endpoint_to_chat_url, env_model, http_user_agent, normalize_vendor, trim_endpoint_to_base, uses_responses_api
from .responses import stream_responses_sync
from .sync import call_openai_compatible
from .tools import parse_tool_arguments, tool_payload
from .usage import (
    assistant_message_from_response,
    base_assistant_message as _base_assistant_message,
    usage_from_openai as _usage_from_openai,
)


def _openai_stream_payload(model: dict[str, Any], context: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    payload: dict[str, Any] = {
        "model": model.get("id"),
        "messages": to_openai_messages(context),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if options.get("maxTokens"):
        payload["max_tokens"] = options.get("maxTokens")
    reasoning = str(options.get("reasoning") or "off").strip().lower()
    if reasoning != "off":
        payload["reasoning_effort"] = reasoning
    tools = tool_payload(context.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _iter_sse_data(response: Any) -> Any:
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line or line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data:
            yield data


def _stream_openai_compatible_sync(
    model: dict[str, Any],
    context: dict[str, Any],
    options: dict[str, Any],
    push: Callable[[dict[str, Any]], None],
) -> None:
    if uses_responses_api(model):
        stream_responses_sync(model, context, options, push)
        return

    api_key = options.get("apiKey")
    if not api_key:
        raise RuntimeError(f"模型 {model.get('provider')}/{model.get('id')} 缺少 API Key")

    partial = _base_assistant_message(model, [])

    def push_partial(event: dict[str, Any]) -> None:
        event["partial"] = deepcopy(partial)
        push(event)

    push({"type": "start", "partial": deepcopy(partial)})

    payload = _openai_stream_payload(model, context, options)
    text_index: int | None = None
    thinking_index: int | None = None
    tool_indexes: dict[int, int] = {}
    tool_argument_buffers: dict[int, str] = {}
    finish_reason = "stop"
    usage: dict[str, Any] | None = None
    stream_started = False

    def request_for_payload() -> urllib.request.Request:
        return urllib.request.Request(
            endpoint_to_chat_url(model),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {api_key}",
                "accept": "text/event-stream",
                "user-agent": http_user_agent(),
            },
        )

    def consume(response: Any) -> bool:
        nonlocal finish_reason, stream_started, thinking_index, text_index, usage
        received_data = False
        for data in _iter_sse_data(response):
            received_data = True
            stream_started = True
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk.get("usage"), dict):
                usage = chunk.get("usage")
            choice = (chunk.get("choices") or [{}])[0]
            delta = choice.get("delta") or {}
            if choice.get("finish_reason"):
                finish_reason = choice.get("finish_reason")

            reasoning_field = next(
                (
                    field
                    for field in ("reasoning_content", "reasoning", "reasoning_text")
                    if isinstance(delta.get(field), str) and delta.get(field)
                ),
                None,
            )
            reasoning_delta = delta.get(reasoning_field) if reasoning_field else None
            if isinstance(reasoning_delta, str) and reasoning_delta:
                content = partial.setdefault("content", [])
                if thinking_index is None:
                    thinking_index = len(content)
                    signature = (
                        "reasoning_content"
                        if model.get("provider") == "opencode-go" and reasoning_field == "reasoning"
                        else reasoning_field
                    )
                    content.append({"type": "thinking", "thinking": "", "thinkingSignature": signature})
                    push_partial({"type": "thinking_start", "contentIndex": thinking_index})
                content[thinking_index]["thinking"] += reasoning_delta
                push_partial({"type": "thinking_delta", "contentIndex": thinking_index, "delta": reasoning_delta})

            text_delta = delta.get("content")
            if isinstance(text_delta, str) and text_delta:
                content = partial.setdefault("content", [])
                if text_index is None:
                    text_index = len(content)
                    content.append({"type": "text", "text": ""})
                    push_partial({"type": "text_start", "contentIndex": text_index})
                content[text_index]["text"] += text_delta
                push_partial({"type": "text_delta", "contentIndex": text_index, "delta": text_delta})

            for call_delta in delta.get("tool_calls") or []:
                call_position = int(call_delta.get("index") or 0)
                function = call_delta.get("function") or {}
                content = partial.setdefault("content", [])
                if call_position not in tool_indexes:
                    tool_indexes[call_position] = len(content)
                    tool_argument_buffers[call_position] = ""
                    content.append(
                        {
                            "type": "toolCall",
                            "id": call_delta.get("id") or f"call_{now_ms()}_{call_position}",
                            "name": function.get("name") or "unknown_tool",
                            "arguments": {},
                        }
                    )
                    push_partial({"type": "toolcall_start", "contentIndex": tool_indexes[call_position]})
                block = content[tool_indexes[call_position]]
                if call_delta.get("id"):
                    block["id"] = call_delta.get("id")
                if function.get("name"):
                    block["name"] = function.get("name")
                arguments_delta = function.get("arguments")
                if isinstance(arguments_delta, str) and arguments_delta:
                    tool_argument_buffers[call_position] += arguments_delta
                    block["arguments"] = parse_tool_arguments(tool_argument_buffers[call_position])
                    push_partial(
                        {
                            "type": "toolcall_delta",
                            "contentIndex": tool_indexes[call_position],
                            "delta": arguments_delta,
                        }
                    )
        return received_data

    max_attempts = max(1, min(5, int(options.get("maxRetries", 2)) + 1))
    max_delay_ms = max(0, int(options.get("maxRetryDelayMs") or 5_000))
    try:
        idle_timeout_seconds = max(10, min(300, int(os.environ.get("MON_AGENT_MODEL_IDLE_TIMEOUT_SECONDS", "60"))))
    except ValueError:
        idle_timeout_seconds = 60
    attempt = 1
    stream_options_fallback_used = False
    while True:
        stream_started = False
        try:
            with urllib.request.urlopen(request_for_payload(), timeout=idle_timeout_seconds) as response:
                consume(response)
            if not stream_started:
                raise EOFError("模型流在返回任何事件前结束")
            break
        except urllib.error.HTTPError as error:
            error_text = error.read().decode("utf-8", errors="replace")
            if (
                not stream_options_fallback_used
                and error.code in {400, 422}
                and "stream_options" in error_text
            ):
                payload.pop("stream_options", None)
                stream_options_fallback_used = True
                continue
            if error.code not in {408, 425, 429, 500, 502, 503, 504} or attempt >= max_attempts:
                raise RuntimeError(f"模型请求失败: {error.code} {error.reason} {error_text[:800]}") from error
            retry_reason = f"HTTP {error.code} {error.reason}"
            status_code: int | None = error.code
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, ConnectionError, EOFError) as error:
            if stream_started or attempt >= max_attempts:
                raise
            retry_reason = str(error)
            status_code = None

        attempt += 1
        delay_ms = min(max_delay_ms, 500 * (2 ** (attempt - 2)))
        push(
            {
                "type": "provider_retry",
                "attempt": attempt,
                "maxAttempts": max_attempts,
                "delayMs": delay_ms,
                "reason": retry_reason,
                "statusCode": status_code,
            }
        )
        if delay_ms:
            time.sleep(delay_ms / 1000)

    if thinking_index is not None:
        push_partial({"type": "thinking_end", "contentIndex": thinking_index})
    if text_index is not None:
        push_partial({"type": "text_end", "contentIndex": text_index})
    for content_index in tool_indexes.values():
        push_partial({"type": "toolcall_end", "contentIndex": content_index, "toolCall": deepcopy(partial["content"][content_index])})

    if not partial.get("content"):
        partial["content"] = [{"type": "text", "text": ""}]
    partial["usage"] = _usage_from_openai(usage)
    partial["stopReason"] = "tool_calls" if finish_reason == "tool_calls" else finish_reason
    push({"type": "done", "message": deepcopy(partial)})


async def stream_openai_compatible(model: dict[str, Any], context: dict[str, Any], options: dict[str, Any]) -> AssistantMessageEventStream:
    stream = AssistantMessageEventStream()
    loop = asyncio.get_running_loop()

    def push_threadsafe(event: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(stream.push, event)

    async def run() -> None:
        try:
            await asyncio.to_thread(_stream_openai_compatible_sync, model, context, options, push_threadsafe)
        except Exception as error:
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": ""}],
                "api": model.get("api", "openai-completions"),
                "provider": model.get("provider", "openai"),
                "model": model.get("id", "unknown"),
                "stopReason": "error",
                "errorMessage": str(error),
                "timestamp": now_ms(),
            }
            stream.push({"type": "error", "error": message})

    asyncio.create_task(run())
    return stream
