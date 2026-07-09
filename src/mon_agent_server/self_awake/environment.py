from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..calendar_context import build_environment_awareness
from ..config import environment_context, localize_environment_times
from ..logging import get_logger

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")


def self_awake_now(app: AppState, env_context: dict[str, Any] | None = None) -> datetime:
    environment = getattr(app.config, "environment", None)
    timezone_name = str((env_context or {}).get("timezone") or getattr(environment, "timezone", "") or "").strip()
    if timezone_name:
        try:
            return datetime.now(ZoneInfo(timezone_name))
        except ZoneInfoNotFoundError:
            pass
    return datetime.now().astimezone()


def resolve_self_awake_environment_context(app: AppState, token: str | None = None) -> dict[str, Any]:
    try:
        resolver = getattr(app, "environment_context_for_token", None)
        if callable(resolver):
            env = resolver(token)
            timezone_name = env.get("timezone") if isinstance(env, dict) else None
            return localize_environment_times(env, timezone_name) if isinstance(env, dict) else env
    except Exception as error:
        logger.warning(f"读取用户环境配置失败，使用本地默认值: {error}")
    env_config = getattr(app.config, "environment", None)
    if env_config is not None:
        env = environment_context(env_config)
        return localize_environment_times(env, env.get("timezone"))
    return {"timezone": "Asia/Shanghai", "locale": "zh-CN", "location": {}}


def build_self_awake_environment(app: AppState, env_context: dict[str, Any] | None = None) -> dict[str, Any]:
    env = env_context or resolve_self_awake_environment_context(app)
    now = self_awake_now(app, env)
    location = env.get("location") if isinstance(env.get("location"), dict) else {}
    locale = str(env.get("locale") or "zh-CN")
    return strip_self_awake_nearby_festivals(
        build_environment_awareness(
            {
                "timezone": str(env.get("timezone") or now.tzname() or ""),
                "locale": locale,
                "location": {key: value for key, value in location.items() if value not in (None, "")},
            },
            now,
            nearby_days=45,
        )
    )


def strip_self_awake_nearby_festivals(environment: dict[str, Any]) -> dict[str, Any]:
    cleaned = dict(environment)
    date_context = cleaned.get("date")
    if isinstance(date_context, dict):
        cleaned["date"] = {key: value for key, value in date_context.items() if key != "nearby_festivals"}
    return cleaned


def enrich_self_awake_context(
    context: dict[str, Any] | None,
    app: AppState,
    env_context: dict[str, Any] | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    enriched = dict(context or {})
    if env_context is None:
        env_context = resolve_self_awake_environment_context(app, token)
    enriched["current_time"] = self_awake_now(app, env_context).isoformat()
    current_environment = enriched.get("environment") if isinstance(enriched.get("environment"), dict) else {}
    default_environment = build_self_awake_environment(app, env_context)
    merged_environment = {**default_environment, **current_environment}
    for key in ("location", "date"):
        default_value = default_environment.get(key) if isinstance(default_environment.get(key), dict) else {}
        current_value = current_environment.get(key) if isinstance(current_environment.get(key), dict) else {}
        merged_environment[key] = {**default_value, **current_value}
    enriched["environment"] = strip_self_awake_nearby_festivals(merged_environment)
    return enriched


def enrich_self_awake_request(
    request: dict[str, Any],
    app: AppState,
    env_context: dict[str, Any] | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    return {
        **request,
        "context": enrich_self_awake_context(
            request.get("context") if isinstance(request.get("context"), dict) else {},
            app,
            env_context,
            token,
        ),
    }
