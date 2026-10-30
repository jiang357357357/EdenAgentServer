"""Stable cache-key generation over source identity and every processing setting."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel


def cache_key(source_identity: dict[str, Any], settings: BaseModel | dict[str, Any]) -> str:
    if isinstance(settings, BaseModel):
        settings_data = settings.model_dump(mode="json", exclude_none=False)
    else:
        settings_data = settings
    payload = json.dumps(
        {"source": source_identity, "settings": settings_data},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
