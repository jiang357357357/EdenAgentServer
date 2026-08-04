from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any


SERVICE_ID_HEADER = "X-Mon-Service-ID"
SCOPE_HEADER = "X-Mon-Service-Scope"
TIMESTAMP_HEADER = "X-Mon-Service-Timestamp"
NONCE_HEADER = "X-Mon-Service-Nonce"
SIGNATURE_HEADER = "X-Mon-Service-Signature"
SERVICE_SECRET_ENV = "MON_SERVICE_SHARED_SECRET"
MAX_CLOCK_SKEW_SECONDS = 60


class ServiceAuthenticationError(PermissionError):
    pass


_seen_nonces: dict[str, int] = {}
_nonce_lock = threading.Lock()


def _load_workspace_service_environment() -> None:
    for parent in Path(__file__).resolve().parents:
        if not (parent / ".monconfig").is_file():
            continue
        env_file = parent / "Config" / "ENV" / "service-auth.env"
        if not env_file.is_file():
            continue
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() == SERVICE_SECRET_ENV:
                os.environ.setdefault(SERVICE_SECRET_ENV, value.strip().strip('"').strip("'"))
                return
        return


_load_workspace_service_environment()


def canonical_service_message(
    service_id: str,
    scope: str,
    timestamp: str,
    nonce: str,
    method: str,
    path: str,
    body: bytes,
    subject_user_id: str = "",
) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    parts = [service_id, scope, timestamp, nonce]
    if subject_user_id:
        parts.append(subject_user_id)
    parts.extend([method.upper(), path, body_hash])
    return "\n".join(parts).encode("utf-8")


def sign_service_request(
    service_id: str,
    scope: str,
    method: str,
    path: str,
    body: bytes,
    *,
    subject_user_id: str = "",
) -> dict[str, str]:
    secret = os.environ.get(SERVICE_SECRET_ENV, "").strip()
    if not secret:
        raise ServiceAuthenticationError("服务身份认证未配置")
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    signature = hmac.new(
        secret.encode("utf-8"),
        canonical_service_message(service_id, scope, timestamp, nonce, method, path, body, subject_user_id),
        hashlib.sha256,
    ).hexdigest()
    headers = {
        SERVICE_ID_HEADER: service_id,
        SCOPE_HEADER: scope,
        TIMESTAMP_HEADER: timestamp,
        NONCE_HEADER: nonce,
        SIGNATURE_HEADER: signature,
    }
    if subject_user_id:
        headers["X-Mon-Subject-User-ID"] = subject_user_id
    return headers


def verify_service_request(headers: Any, method: str, path: str, body: bytes, required_scope: str) -> str:
    secret = os.environ.get(SERVICE_SECRET_ENV, "").strip()
    if not secret:
        raise ServiceAuthenticationError("服务身份认证未配置")
    service_id = str(headers.get(SERVICE_ID_HEADER) or "").strip()
    scope = str(headers.get(SCOPE_HEADER) or "").strip()
    timestamp = str(headers.get(TIMESTAMP_HEADER) or "").strip()
    nonce = str(headers.get(NONCE_HEADER) or "").strip()
    signature = str(headers.get(SIGNATURE_HEADER) or "").strip().lower()
    if not all([service_id, scope, timestamp, nonce, signature]):
        raise ServiceAuthenticationError("服务身份请求头不完整")
    if service_id != "monos" or required_scope not in scope.split():
        raise ServiceAuthenticationError("服务身份或 scope 不允许")
    try:
        timestamp_value = int(timestamp)
    except ValueError as error:
        raise ServiceAuthenticationError("服务时间戳无效") from error
    now = int(time.time())
    if abs(now - timestamp_value) > MAX_CLOCK_SKEW_SECONDS:
        raise ServiceAuthenticationError("服务签名已过期")
    expected = hmac.new(
        secret.encode("utf-8"),
        canonical_service_message(service_id, scope, timestamp, nonce, method, path, body),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ServiceAuthenticationError("服务签名无效")
    nonce_key = f"{service_id}:{nonce}"
    with _nonce_lock:
        expired_before = now - MAX_CLOCK_SKEW_SECONDS
        for key, seen_at in list(_seen_nonces.items()):
            if seen_at < expired_before:
                _seen_nonces.pop(key, None)
        if nonce_key in _seen_nonces:
            raise ServiceAuthenticationError("服务请求 nonce 已使用")
        _seen_nonces[nonce_key] = now
    return service_id
