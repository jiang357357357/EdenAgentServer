from __future__ import annotations

import json
from typing import Any


def parse_json(text: str) -> Any:
    if not text.strip():
        return None
    return json.loads(text)


def error_message(status: int, reason: str, text: str) -> str:
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return str(data.get("error") or data.get("detail") or data.get("message") or f"{status} {reason}")
    except Exception:
        pass
    return f"{status} {reason}"


def is_auth_expired(status: int, message: str) -> bool:
    haystack = message.lower()
    return status == 401 or any(
        token in haystack
        for token in ["authentication_expired", "not_authenticated", "invalid token", "token invalid", "token无效", "认证凭据"]
    )
