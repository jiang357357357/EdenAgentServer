from __future__ import annotations

from copy import deepcopy
import json
import asyncio
from typing import Any

import httpx

from ..agent_api import AssistantMessageEventStream, now_ms
from .messages import message_content, to_openai_messages
from .http_stream import RETRYABLE_STATUS_CODES, iter_sse_data, open_sse, stream_timeouts
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
    prompt_cache_key = context.get("promptCacheKey") or context.get("prompt_cache_key")
    if prompt_cache_key and str(model.get("provider") or "") in {"openai", "opencode-go"}:
        payload["prompt_cache_key"] = str(prompt_cache_key)
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


async def _stream_openai_compatible(
    model: dict[str, Any],
    context: dict[str, Any],
    options: dict[str, Any],
    push: Any,
) -> None:
    signal = options.get("signal")

    def raise_if_aborted() -> None:
        if getattr(signal, "aborted", False):
            raise asyncio.CancelledError

    raise_if_aborted()
    if uses_responses_api(model):
        await stream_responses_sync(model, context, options, push)
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

    def reset_partial_for_retry() -> None:
        """Retract provisional text/reasoning while preserving stable part indexes."""
        nonlocal finish_reason, stream_started, usage
        for block in partial.get("content") or []:
            if block.get("type") == "text":
                block["text"] = ""
            elif block.get("type") == "thinking":
                block["thinking"] = ""
        finish_reason = "stop"
        usage = None
        stream_started = False
        push_partial({"type": "stream_reset"})

    async def consume(response: Any, first_event_timeout: int, idle_timeout: int) -> bool:
        nonlocal finish_reason, stream_started, thinking_index, text_index, usage
        received_data = False
        async for data in iter_sse_data(
            response,
            first_event_timeout_seconds=first_event_timeout,
            idle_timeout_seconds=idle_timeout,
        ):
            raise_if_aborted()
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
    connect_timeout_seconds, first_event_timeout_seconds, idle_timeout_seconds = stream_timeouts()
    attempt = 1
    stream_options_fallback_used = False
    while True:
        raise_if_aborted()
        stream_started = False
        try:
            async with open_sse(
                endpoint_to_chat_url(model),
                payload=payload,
                headers={
                    "content-type": "application/json",
                    "authorization": f"Bearer {api_key}",
                    "accept": "text/event-stream",
                    "user-agent": http_user_agent(),
                },
                connect_timeout_seconds=connect_timeout_seconds,
            ) as response:
                if response.status_code >= 400:
                    error_text = (await response.aread()).decode("utf-8", errors="replace")
                    if (
                        not stream_options_fallback_used
                        and response.status_code in {400, 422}
                        and "stream_options" in error_text
                    ):
                        payload.pop("stream_options", None)
                        stream_options_fallback_used = True
                        continue
                    if response.status_code not in RETRYABLE_STATUS_CODES or attempt >= max_attempts:
                        raise RuntimeError(f"模型请求失败: {response.status_code} {error_text[:800]}")
                    raise httpx.HTTPStatusError(
                        f"HTTP {response.status_code}", request=response.request, response=response
                    )
                await consume(response, first_event_timeout_seconds, idle_timeout_seconds)
            if not stream_started:
                raise EOFError("模型流在返回任何事件前结束")
            break
        except httpx.HTTPStatusError as error:
            retry_reason = f"HTTP {error.response.status_code}"
            status_code: int | None = error.response.status_code
        except (httpx.HTTPError, TimeoutError, ConnectionError, EOFError) as error:
            if tool_indexes or attempt >= max_attempts:
                raise
            retry_reason = str(error)
            status_code = None

        if stream_started:
            reset_partial_for_retry()

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
            await asyncio.sleep(delay_ms / 1000)
            raise_if_aborted()

    raise_if_aborted()
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
    async def run() -> None:
        try:
            await _stream_openai_compatible(model, context, options, stream.push)
        except Exception as error:
            raw_error = str(error)
            normalized_error = raw_error.lower()
            if "incomplete chunked read" in normalized_error or (
                "peer closed connection" in normalized_error and "complete message body" in normalized_error
            ):
                error_message = "模型服务在生成过程中提前断开连接；自动重试后仍未完成，请重试。"
            else:
                error_message = raw_error
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": ""}],
                "api": model.get("api", "openai-completions"),
                "provider": model.get("provider", "openai"),
                "model": model.get("id", "unknown"),
                "stopReason": "error",
                "errorMessage": error_message,
                "timestamp": now_ms(),
            }
            stream.push({"type": "error", "error": message})

    stream.attach_producer(asyncio.create_task(run()))
    return stream
