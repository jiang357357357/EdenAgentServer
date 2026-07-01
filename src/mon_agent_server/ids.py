from __future__ import annotations

import secrets
import time


def now_ms() -> int:
    return int(time.time() * 1000)


def create_id(prefix: str) -> str:
    stamp = format(now_ms(), "x")
    suffix = secrets.token_hex(4)
    return f"{prefix}_{stamp}_{suffix}"
