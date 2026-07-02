from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any

from mon_agent_core import AssistantMessageEventStream
from mon_agent_core.types import now_ms


def normalize_vendor(value: str | None) -> str:
    normalized = (value or "openai").strip().lower().replace("_", "-")
    if normalized in {"custom", "monsystem"}:
        return "openai"
    if normalized == "mimo":
        return "xiaomi"
    return normalized or "openai"


def trim_endpoint_to_base(endpoint: str | None) -> str | None:
    raw = (endpoint or "").strip()
    if not raw:
        return None
    for suffix in ["/chat/completions", "/responses", "/messages"]:
        if raw.lower().endswith(suffix):
            return raw[: -len(suffix)].rstrip("/")
    return raw.rstrip("/")


def endpoint_to_chat_url(model: dict[str, Any]) -> str:
    base_url = (model.get("baseUrl") or "").rstrip("/")
    if not base_url:
        base_url = "https://api.openai.com/v1"
    if base_url.lower().endswith("/chat/completions"):
        return base_url
    return f"{base_url}/chat/completions"


def http_user_agent() -> str:
    return os.environ.get("MON_AGENT_HTTP_USER_AGENT") or "MonAgent/0.1"


def env_model() -> tuple[dict[str, Any], str | None, str, str]:
    raw = os.environ.get("MON_AGENT_MODEL") or "openai/gpt-4o-mini"
    provider, _, model_id = raw.partition("/")
    if not model_id:
        model_id = provider
        provider = "openai"
    provider = normalize_vendor(provider)
    api_key = os.environ.get(f"{provider.upper().replace('-', '_')}_API_KEY") or os.environ.get("OPENAI_API_KEY")
    model = {
        "id": model_id,
        "name": model_id,
        "api": "openai-completions",
        "provider": provider,
        "baseUrl": os.environ.get("MON_AGENT_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1",
        "input": ["text", "image"],
        "reasoning": (os.environ.get("MON_AGENT_THINKING_LEVEL") or "off").lower() != "off",
    }
    return model, api_key, f"{provider}/{model_id}", "env"


def core_model(core: dict[str, Any]) -> tuple[dict[str, Any], str | None, str, str]:
    ai_entity = core["aiEntity"]
    provider = normalize_vendor(ai_entity.get("vendor"))
    model_id = ai_entity.get("ai_model") or "unknown"
    base_url = trim_endpoint_to_base(ai_entity.get("api_endpoint"))
    model = {
        "id": model_id,
        "name": ai_entity.get("ai_name") or model_id,
        "api": "openai-completions",
        "provider": provider,
        "baseUrl": base_url or "https://api.openai.com/v1",
        "input": ["text", "image"] if ai_entity.get("is_multimodal") else ["text"],
        "reasoning": False,
    }
    return model, ai_entity.get("api_key"), f"{provider}/{model_id}", "core"


def message_content(blocks: Any) -> Any:
    if isinstance(blocks, str):
        return blocks
    if not isinstance(blocks, list):
        return ""
    output: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            output.append({"type": "text", "text": block.get("text") or ""})
        elif block.get("type") == "image" and block.get("data"):
            mime = block.get("mimeType") or "image/png"
            output.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{block.get('data')}"}})
    if not output:
        return ""
    if len(output) == 1 and output[0]["type"] == "text":
        return output[0]["text"]
    return output


def to_openai_messages(context: dict[str, Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    system_prompt = context.get("systemPrompt") or context.get("system_prompt")
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for message in context.get("messages", []):
        role = message.get("role")
        if role == "user":
            messages.append({"role": "user", "content": message_content(message.get("content"))})
        elif role == "assistant":
            text = "\n".join(block.get("text", "") for block in message.get("content", []) if isinstance(block, dict) and block.get("type") == "text")
            tool_calls = []
            for block in message.get("content", []):
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    tool_calls.append(
                        {
                            "id": block.get("id"),
                            "type": "function",
                            "function": {
                                "name": block.get("name"),
                                "arguments": json.dumps(block.get("arguments") or {}, ensure_ascii=False),
                            },
                        }
                    )
            item: dict[str, Any] = {"role": "assistant", "content": text or None}
            if tool_calls:
                item["tool_calls"] = tool_calls
            messages.append(item)
        elif role == "toolResult":
            text = "\n".join(block.get("text", "") for block in message.get("content", []) if isinstance(block, dict) and block.get("type") == "text")
            messages.append({"role": "tool", "tool_call_id": message.get("toolCallId"), "content": text})
    return messages


def tool_payload(tools: list[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for tool in tools:
        output.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": dict(tool.parameters or {"type": "object", "properties": {}}),
                },
            }
        )
    return output


def parse_tool_arguments(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def call_openai_compatible(model: dict[str, Any], context: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    api_key = options.get("apiKey")
    if not api_key:
        raise RuntimeError(f"模型 {model.get('provider')}/{model.get('id')} 缺少 API Key")
    payload: dict[str, Any] = {
        "model": model.get("id"),
        "messages": to_openai_messages(context),
        "stream": False,
    }
    tools = tool_payload(context.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint_to_chat_url(model),
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
            "accept": "application/json",
            "user-agent": http_user_agent(),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"模型请求失败: {error.code} {error.reason} {text[:800]}") from error


def assistant_message_from_response(model: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    choice = (response.get("choices") or [{}])[0]
    raw_message = choice.get("message") or {}
    content_blocks: list[dict[str, Any]] = []
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
    usage = response.get("usage") or {}
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    finish_reason = choice.get("finish_reason") or "stop"
    return {
        "role": "assistant",
        "content": content_blocks or [{"type": "text", "text": ""}],
        "api": model.get("api", "openai-completions"),
        "provider": model.get("provider", "openai"),
        "model": model.get("id", "unknown"),
        "usage": {
            "input": prompt_tokens,
            "output": completion_tokens,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": prompt_tokens + completion_tokens,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": "tool_calls" if finish_reason == "tool_calls" else finish_reason,
        "timestamp": now_ms(),
    }


async def stream_openai_compatible(model: dict[str, Any], context: dict[str, Any], options: dict[str, Any]) -> AssistantMessageEventStream:
    stream = AssistantMessageEventStream()

    async def run() -> None:
        try:
            response = await asyncio.to_thread(call_openai_compatible, model, context, options)
            message = assistant_message_from_response(model, response)
            stream.push({"type": "start", "partial": {**message, "content": []}})
            stream.push({"type": "done", "message": message})
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
