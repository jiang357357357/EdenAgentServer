from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .schema import EnvironmentConfig


def environment_context(environment: EnvironmentConfig) -> dict[str, Any]:
    location = {
        "country": environment.country,
        "region": environment.region,
        "city": environment.city,
        "latitude": environment.latitude,
        "longitude": environment.longitude,
    }
    return {
        "timezone": environment.timezone,
        "locale": environment.locale,
        "location": {key: value for key, value in location.items() if value not in (None, "")},
    }


def local_timezone(timezone_name: str | None) -> ZoneInfo | None:
    name = str(timezone_name or "").strip()
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return None


def localize_iso_datetime(value: str, timezone_name: str | None) -> str:
    text = value.strip()
    if "T" not in text and " " not in text:
        return value
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        return value
    local_tz = local_timezone(timezone_name) or datetime.now().astimezone().tzinfo
    return parsed.astimezone(local_tz).isoformat()


def localize_environment_times(value: Any, timezone_name: str | None) -> Any:
    if isinstance(value, dict):
        return {key: localize_environment_times(item, timezone_name) for key, item in value.items()}
    if isinstance(value, list):
        return [localize_environment_times(item, timezone_name) for item in value]
    if isinstance(value, str):
        return localize_iso_datetime(value, timezone_name)
    return value


def merge_environment_context(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    merged = deepcopy(base)
    if not isinstance(override, dict):
        return localize_environment_times(merged, merged.get("timezone"))
    for key in ("timezone", "locale"):
        if override.get(key) not in (None, ""):
            merged[key] = override[key]
    override_location = override.get("location") if isinstance(override.get("location"), dict) else {}
    base_location = merged.get("location") if isinstance(merged.get("location"), dict) else {}
    merged["location"] = {**base_location, **{key: value for key, value in override_location.items() if value not in (None, "")}}
    for key, value in override.items():
        if key not in {"timezone", "locale", "location"} and value not in (None, ""):
            merged[key] = value
    return localize_environment_times(merged, merged.get("timezone"))
