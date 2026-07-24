from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "self-awake.v1"
SUPPORTED_SCHEMA_VERSIONS = {SCHEMA_VERSION}


class SelfAwakeContractError(ValueError):
    pass


def normalize_self_awake_request(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize v1 and legacy requests without silently accepting future schemas."""
    request = dict(raw or {})
    schema_version = str(request.get("schema_version") or SCHEMA_VERSION).strip()
    if schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        raise SelfAwakeContractError(f"不支持的自醒协议版本: {schema_version}")

    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    event = context.get("event") if isinstance(context.get("event"), dict) else {}
    event_id = str(request.get("event_id") or event.get("event_id") or "").strip()
    job_id = str(request.get("job_id") or "").strip()
    idempotency_key = str(request.get("idempotency_key") or event_id or job_id).strip()

    if schema_version == SCHEMA_VERSION:
        missing = [
            name
            for name, value in (
                ("job_id", job_id),
                ("event_id", event_id),
                ("idempotency_key", idempotency_key),
            )
            if not value
        ]
        # Legacy callers did not send schema_version. They remain accepted during v1 migration.
        if request.get("schema_version") and missing:
            raise SelfAwakeContractError(f"自醒 v1 请求缺少字段: {', '.join(missing)}")

    return {
        **request,
        "schema_version": schema_version,
        "job_id": job_id,
        "event_id": event_id,
        "idempotency_key": idempotency_key,
        "context": context,
    }


def contract_response_fields(request: dict[str, Any]) -> dict[str, str]:
    return {
        "schema_version": str(request.get("schema_version") or SCHEMA_VERSION),
        "job_id": str(request.get("job_id") or ""),
        "event_id": str(request.get("event_id") or ""),
        "idempotency_key": str(request.get("idempotency_key") or ""),
    }
