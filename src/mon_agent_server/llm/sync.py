from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .messages import to_openai_messages
from .models import endpoint_to_chat_url, http_user_agent
from .tools import tool_payload


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
    if options.get("maxTokens"):
        payload["max_tokens"] = options.get("maxTokens")
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
