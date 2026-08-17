from __future__ import annotations

from copy import deepcopy
import json
import asyncio
from typing import Any

import httpx

from mon_agent_core.types import now_ms

from .messages import to_responses_input
from .http_stream import RETRYABLE_STATUS_CODES, iter_sse_data, open_sse, stream_timeouts
from .models import endpoint_to_responses_url, http_user_agent, supports_native_web_search
from .tools import parse_tool_arguments, responses_tool_payload
from .usage import base_assistant_message, usage_from_openai


def responses_stream_payload(model: dict[str, Any], context: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model.get("id"),
        "input": to_responses_input(context),
        "stream": True,
    }
    prompt_cache_key = context.get("promptCacheKey") or context.get("prompt_cache_key")
    if prompt_cache_key:
        payload["prompt_cache_key"] = str(prompt_cache_key)
    instructions = context.get("systemPrompt") or context.get("system_prompt")
    if instructions:
        payload["instructions"] = instructions

    reasoning = str(options.get("reasoning") or "off").strip().lower()
    if reasoning != "off":
        payload["reasoning"] = {"effort": reasoning, "summary": "detailed"}
    if options.get("maxTokens"):
        payload["max_output_tokens"] = options.get("maxTokens")

    tools = responses_tool_payload(
        context.get("tools", []),
        native_web_search=supports_native_web_search(model),
    )
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _responses_usage(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    input_tokens = int(raw.get("input_tokens") or 0)
    output_tokens = int(raw.get("output_tokens") or 0)
    input_details = raw.get("input_tokens_details") if isinstance(raw.get("input_tokens_details"), dict) else {}
    cached_tokens = int(input_details.get("cached_tokens") or 0)
    return usage_from_openai(
        {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "prompt_tokens_details": {"cached_tokens": cached_tokens},
        }
    )


async def stream_responses_sync(
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
    api_key = options.get("apiKey")
    if not api_key:
        raise RuntimeError(f"模型 {model.get('provider')}/{model.get('id')} 缺少 API Key")

    partial = base_assistant_message(model, [])

    def push_partial(event: dict[str, Any]) -> None:
        event["partial"] = deepcopy(partial)
        push(event)

    push({"type": "start", "partial": deepcopy(partial)})
    payload = responses_stream_payload(model, context, options)
    thinking_index: int | None = None
    text_index: int | None = None
    tool_indexes: dict[int, int] = {}
    tool_argument_buffers: dict[int, str] = {}
    usage: dict[str, Any] | None = None
    response_status = "completed"
    stream_started = False
    native_sources: list[dict[str, str]] = []

    def ensure_tool(output_index: int, item: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        item = item or {}
        content = partial.setdefault("content", [])
        if output_index not in tool_indexes:
            content_index = len(content)
            tool_indexes[output_index] = content_index
            raw_arguments = item.get("arguments") if isinstance(item.get("arguments"), str) else ""
            tool_argument_buffers[output_index] = raw_arguments
            content.append(
                {
                    "type": "toolCall",
                    "id": item.get("call_id") or f"call_{now_ms()}_{output_index}",
                    "name": item.get("name") or "unknown_tool",
                    "arguments": parse_tool_arguments(raw_arguments),
                    "providerItemId": item.get("id"),
                }
            )
            push_partial({"type": "toolcall_start", "contentIndex": content_index})
        content_index = tool_indexes[output_index]
        block = content[content_index]
        if item.get("call_id"):
            block["id"] = item["call_id"]
        if item.get("name"):
            block["name"] = item["name"]
        if item.get("id"):
            block["providerItemId"] = item["id"]
        return content_index, block

    async def consume(response: Any, first_event_timeout: int, idle_timeout: int) -> bool:
        nonlocal thinking_index, text_index, usage, response_status, stream_started
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
                event = json.loads(data)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "error":
                raise RuntimeError(str((event.get("error") or {}).get("message") or "Responses API 返回错误"))
            if event_type == "response.failed":
                failure = (event.get("response") or {}).get("error") or {}
                raise RuntimeError(str(failure.get("message") or failure.get("code") or "Responses API 请求失败"))

            if event_type in {"response.reasoning_summary_text.delta", "response.reasoning_text.delta"}:
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    content = partial.setdefault("content", [])
                    if thinking_index is None:
                        thinking_index = len(content)
                        content.append({"type": "thinking", "thinking": "", "thinkingSignature": "reasoning_summary"})
                        push_partial({"type": "thinking_start", "contentIndex": thinking_index})
                    content[thinking_index]["thinking"] += delta
                    push_partial({"type": "thinking_delta", "contentIndex": thinking_index, "delta": delta})
                continue

            if event_type == "response.output_text.delta":
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    content = partial.setdefault("content", [])
                    if text_index is None:
                        text_index = len(content)
                        content.append({"type": "text", "text": ""})
                        push_partial({"type": "text_start", "contentIndex": text_index})
                    content[text_index]["text"] += delta
                    push_partial({"type": "text_delta", "contentIndex": text_index, "delta": delta})
                continue

            if event_type == "response.output_item.added":
                item = event.get("item") or {}
                if item.get("type") == "function_call":
                    ensure_tool(int(event.get("output_index") or 0), item)
                continue

            if event_type == "response.function_call_arguments.delta":
                output_index = int(event.get("output_index") or 0)
                content_index, block = ensure_tool(output_index)
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    tool_argument_buffers[output_index] += delta
                    block["arguments"] = parse_tool_arguments(tool_argument_buffers[output_index])
                    push_partial({"type": "toolcall_delta", "contentIndex": content_index, "delta": delta})
                continue

            if event_type == "response.output_item.done":
                item = event.get("item") or {}
                if item.get("type") == "function_call":
                    output_index = int(event.get("output_index") or 0)
                    content_index, block = ensure_tool(output_index, item)
                    raw_arguments = item.get("arguments")
                    if isinstance(raw_arguments, str) and raw_arguments:
                        tool_argument_buffers[output_index] = raw_arguments
                        block["arguments"] = parse_tool_arguments(raw_arguments)
                elif item.get("type") == "message":
                    for content_item in item.get("content") or []:
                        if not isinstance(content_item, dict):
                            continue
                        for annotation in content_item.get("annotations") or []:
                            if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
                                continue
                            url = str(annotation.get("url") or "").strip()
                            title = str(annotation.get("title") or url).strip()
                            if url and not any(source["url"] == url for source in native_sources):
                                native_sources.append({"title": title, "url": url})
                continue

            if event_type == "response.completed":
                completed = event.get("response") or {}
                response_status = str(completed.get("status") or "completed")
                if isinstance(completed.get("usage"), dict):
                    usage = completed["usage"]
        return received_data

    max_attempts = max(1, min(5, int(options.get("maxRetries", 2)) + 1))
    max_delay_ms = max(0, int(options.get("maxRetryDelayMs") or 5_000))
    connect_timeout_seconds, first_event_timeout_seconds, idle_timeout_seconds = stream_timeouts()
    attempt = 1
    while True:
        raise_if_aborted()
        stream_started = False
        try:
            async with open_sse(
                endpoint_to_responses_url(model),
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
            await asyncio.sleep(delay_ms / 1000)
            raise_if_aborted()

    raise_if_aborted()
    if native_sources:
        content = partial.setdefault("content", [])
        existing_text = "\n".join(
            str(block.get("text") or "") for block in content if isinstance(block, dict) and block.get("type") == "text"
        )
        missing = [source for source in native_sources if source["url"] not in existing_text]
        if missing:
            suffix = "\n\n来源：\n" + "\n".join(f"- [{source['title']}]({source['url']})" for source in missing)
            if text_index is None:
                text_index = len(content)
                content.append({"type": "text", "text": ""})
                push_partial({"type": "text_start", "contentIndex": text_index})
            content[text_index]["text"] += suffix
            push_partial({"type": "text_delta", "contentIndex": text_index, "delta": suffix})

    if thinking_index is not None:
        push_partial({"type": "thinking_end", "contentIndex": thinking_index})
    if text_index is not None:
        push_partial({"type": "text_end", "contentIndex": text_index})
    for content_index in tool_indexes.values():
        push_partial(
            {
                "type": "toolcall_end",
                "contentIndex": content_index,
                "toolCall": deepcopy(partial["content"][content_index]),
            }
        )

    if not partial.get("content"):
        partial["content"] = [{"type": "text", "text": ""}]
    partial["usage"] = _responses_usage(usage)
    partial["stopReason"] = "tool_calls" if tool_indexes else ("stop" if response_status == "completed" else response_status)
    push({"type": "done", "message": deepcopy(partial)})
