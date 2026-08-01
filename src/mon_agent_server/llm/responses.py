from __future__ import annotations

from copy import deepcopy
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from mon_agent_core.types import now_ms

from .messages import to_responses_input
from .models import endpoint_to_responses_url, http_user_agent
from .tools import parse_tool_arguments, responses_tool_payload
from .usage import base_assistant_message, usage_from_openai


def responses_stream_payload(model: dict[str, Any], context: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model.get("id"),
        "input": to_responses_input(context),
        "stream": True,
    }
    instructions = context.get("systemPrompt") or context.get("system_prompt")
    if instructions:
        payload["instructions"] = instructions

    reasoning = str(options.get("reasoning") or "off").strip().lower()
    if reasoning != "off":
        payload["reasoning"] = {"effort": reasoning, "summary": "detailed"}
    if options.get("maxTokens"):
        payload["max_output_tokens"] = options.get("maxTokens")

    tools = responses_tool_payload(context.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _iter_sse_data(response: Any) -> Any:
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line or line.startswith(":") or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data:
            yield data


def _responses_usage(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    input_tokens = int(raw.get("input_tokens") or 0)
    output_tokens = int(raw.get("output_tokens") or 0)
    input_details = raw.get("input_tokens_details") if isinstance(raw.get("input_tokens_details"), dict) else {}
    cached_tokens = int(input_details.get("cached_tokens") or 0)
    return usage_from_openai(
        {
            "prompt_tokens": max(0, input_tokens - cached_tokens),
            "completion_tokens": output_tokens,
            "prompt_tokens_details": {"cached_tokens": cached_tokens},
        }
    )


def stream_responses_sync(
    model: dict[str, Any],
    context: dict[str, Any],
    options: dict[str, Any],
    push: Callable[[dict[str, Any]], None],
) -> None:
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

    def request_for_payload() -> urllib.request.Request:
        return urllib.request.Request(
            endpoint_to_responses_url(model),
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
        nonlocal thinking_index, text_index, usage, response_status, stream_started
        received_data = False
        for data in _iter_sse_data(response):
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
                continue

            if event_type == "response.completed":
                completed = event.get("response") or {}
                response_status = str(completed.get("status") or "completed")
                if isinstance(completed.get("usage"), dict):
                    usage = completed["usage"]
        return received_data

    max_attempts = max(1, min(5, int(options.get("maxRetries", 2)) + 1))
    max_delay_ms = max(0, int(options.get("maxRetryDelayMs") or 5_000))
    try:
        idle_timeout_seconds = max(10, min(300, int(os.environ.get("MON_AGENT_MODEL_IDLE_TIMEOUT_SECONDS", "60"))))
    except ValueError:
        idle_timeout_seconds = 60
    attempt = 1
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
