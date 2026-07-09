from __future__ import annotations

from typing import Any


class CoreAuthenticationExpiredError(Exception):
    def __init__(self, path: str, status: int, detail: str) -> None:
        super().__init__(f"Core 认证已失效: {path} - {detail}")
        self.path = path
        self.status = status
        self.detail = detail


def read_auth_token(headers: Any) -> str | None:
    value = headers.get("authorization") or headers.get("Authorization")
    if not value:
        return None
    text = str(value).strip()
    lowered = text.lower()
    if lowered.startswith("token "):
        return text[6:].strip()
    if lowered.startswith("bearer "):
        return text[7:].strip()
    return text or None


def require_core_token(headers: Any) -> str:
    token = read_auth_token(headers)
    if not token:
        raise CoreAuthenticationExpiredError("/api/agent/sessions/", 401, "not_authenticated")
    return token
