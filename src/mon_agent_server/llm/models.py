from __future__ import annotations

import json
import os
from typing import Any


THINKING_LEVELS = {"minimal", "low", "medium", "high", "xhigh"}


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


def endpoint_to_responses_url(model: dict[str, Any]) -> str:
    base_url = (model.get("baseUrl") or "").rstrip("/")
    if not base_url:
        base_url = "https://api.openai.com/v1"
    if base_url.lower().endswith("/responses"):
        return base_url
    return f"{base_url}/responses"


def uses_responses_api(model: dict[str, Any]) -> bool:
    if model.get("api") == "openai-responses":
        return True
    return normalize_vendor(model.get("provider")) == "opencode-go" and str(model.get("id") or "").lower() == "gpt-5.6-luna"


def supports_native_web_search(model: dict[str, Any]) -> bool:
    """Return true only for an adapter explicitly configured for hosted search."""
    return uses_responses_api(model) and model.get("nativeWebSearch") is True


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
    thinking_level = (os.environ.get("MON_AGENT_THINKING_LEVEL") or "off").strip().lower()
    if thinking_level not in THINKING_LEVELS:
        thinking_level = "off"
    model = {
        "id": model_id,
        "name": model_id,
        "api": "openai-completions",
        "provider": provider,
        "baseUrl": os.environ.get("MON_AGENT_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1",
        "input": ["text", "image"],
        "reasoning": thinking_level != "off",
        "thinkingLevel": thinking_level,
        "nativeWebSearch": (os.environ.get("MON_AGENT_NATIVE_WEB_SEARCH") or "").strip().lower() in {"1", "true", "yes", "on"},
    }
    return model, api_key, f"{provider}/{model_id}", "env"


def core_model(core: dict[str, Any]) -> tuple[dict[str, Any], str | None, str, str]:
    ai_entity = core["aiEntity"]
    provider = normalize_vendor(ai_entity.get("vendor"))
    model_id = ai_entity.get("ai_model") or "unknown"
    base_url = trim_endpoint_to_base(ai_entity.get("api_endpoint"))
    default_params = ai_entity.get("default_params")
    if isinstance(default_params, str):
        try:
            default_params = json.loads(default_params)
        except json.JSONDecodeError:
            default_params = {}
    if not isinstance(default_params, dict):
        default_params = {}
    legacy_level = str(default_params.get("thinking_level") or "").strip().lower()
    enabled_value = default_params.get("thinking_enabled")
    if enabled_value is None and legacy_level:
        reasoning_enabled = legacy_level != "off"
    else:
        reasoning_enabled = enabled_value is True or str(enabled_value).strip().lower() in {"1", "true", "yes", "on"}
    thinking_level = str(default_params.get("reasoning_effort") or legacy_level or "medium").strip().lower()
    if thinking_level not in THINKING_LEVELS:
        thinking_level = "medium"
    if not reasoning_enabled:
        thinking_level = "off"

    model = {
        "id": model_id,
        "name": ai_entity.get("ai_name") or model_id,
        "api": "openai-completions",
        "provider": provider,
        "baseUrl": base_url or "https://api.openai.com/v1",
        "input": ["text", "image"] if ai_entity.get("is_multimodal") else ["text"],
        "reasoning": reasoning_enabled,
        "thinkingLevel": thinking_level,
        "nativeWebSearch": default_params.get("native_web_search") is True,
    }
    if str(default_params.get("api") or "").strip().lower() in {"responses", "openai-responses"}:
        model["api"] = "openai-responses"
    context_window = ai_entity.get("contextWindow") or ai_entity.get("context_window") or ai_entity.get("contextLength")
    if context_window is not None:
        model["contextWindow"] = context_window
    return model, ai_entity.get("api_key"), f"{provider}/{model_id}", "core"
