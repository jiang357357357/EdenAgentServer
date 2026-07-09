from __future__ import annotations

import os
from pathlib import Path


def normalize_base_url(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    value = value.replace("://0.0.0.0:", "://127.0.0.1:")
    value = value.replace("://[::]:", "://127.0.0.1:")
    return value


def create_core_base_url(base_url: str | None, host: str | None, port: int) -> str:
    if base_url and base_url.strip():
        return normalize_base_url(base_url)
    resolved_host = host or "127.0.0.1"
    if resolved_host in {"0.0.0.0", "::"}:
        resolved_host = "127.0.0.1"
    return normalize_base_url(f"http://{resolved_host}:{port}")


def env_path(name: str, default: Path, workspace_root: Path) -> Path:
    raw = os.environ.get(name)
    if not raw:
        return default
    value = Path(raw)
    return value if value.is_absolute() else workspace_root / value


def env_float(name: str, raw: str | None) -> float | None:
    value = os.environ.get(name) if os.environ.get(name) not in (None, "") else raw
    if value in (None, ""):
        return None
    try:
        return float(str(value).strip())
    except ValueError:
        return None
