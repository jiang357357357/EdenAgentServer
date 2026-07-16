from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..calendar_context import build_environment_awareness
from ..config import environment_context, localize_environment_times
from ..ids import create_id
from ..logging import get_logger

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")
SELF_AWAKE_EVENT_TYPES = {"startup", "scheduled", "manual", "retry"}


def normalize_self_awake_event(context: dict[str, Any], occurred_at: str) -> dict[str, Any]:
    raw_event = context.get("event") if isinstance(context.get("event"), dict) else {}
    wake = context.get("wake") if isinstance(context.get("wake"), dict) else {}
    raw_type = str(raw_event.get("type") or "").strip().lower()
    legacy_trigger = str(context.get("trigger") or "").strip().lower()
    legacy_source = str(context.get("source") or "").strip().lower()
    legacy_reason = str(wake.get("reason") or "").strip().lower()
    if raw_type not in SELF_AWAKE_EVENT_TYPES:
        if "startup" in {legacy_source, legacy_reason} or "startup" in legacy_trigger or "startup" in legacy_reason:
            raw_type = "startup"
        elif "retry" in legacy_trigger or "retry" in legacy_reason:
            raw_type = "retry"
        elif "manual" in legacy_trigger or "manual" in legacy_reason or "forced" in legacy_reason:
            raw_type = "manual"
        else:
            raw_type = "scheduled"
    source = str(raw_event.get("source") or wake.get("source") or "monagent").strip().lower()
    if source in {"monagent_server", "agent", "agent-api"}:
        source = "monagent"
    reason = str(raw_event.get("reason") or wake.get("reason") or context.get("trigger") or raw_type).strip()
    event: dict[str, Any] = {
        "type": raw_type,
        "source": source or "monagent",
        "reason": reason,
        "occurred_at": str(raw_event.get("occurred_at") or context.get("current_time") or occurred_at),
        "event_id": str(raw_event.get("event_id") or create_id("selfawakeevent")),
    }
    for key in ("subject_type", "subject_id", "scheduler_reason"):
        if raw_event.get(key) not in (None, ""):
            event[key] = str(raw_event[key])
    return event


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
    awareness = build_environment_awareness(
            {
                "timezone": str(env.get("timezone") or now.tzname() or ""),
                "locale": locale,
                "location": {key: value for key, value in location.items() if value not in (None, "")},
            },
            now,
            nearby_days=45,
        )
    if isinstance(env.get("runtime"), dict):
        awareness["runtime"] = dict(env["runtime"])
    return strip_self_awake_nearby_festivals(awareness)


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
    current_time = self_awake_now(app, env_context).isoformat()
    enriched["current_time"] = current_time
    enriched["event"] = normalize_self_awake_event(enriched, current_time)
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
