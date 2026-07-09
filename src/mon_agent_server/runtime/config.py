from __future__ import annotations

import os
from typing import Any


class RuntimeModelConfig:
    def __init__(self, model: dict[str, Any], api_key: str | None, label: str, source: str, core: dict[str, Any] | None) -> None:
        self.model = model
        self.api_key = api_key
        self.label = label
        self.source = source
        self.core = core
        self.supports_images = "image" in (model.get("input") or [])
        self.thinking_level = "medium" if model.get("reasoning") else "off"


def runtime_context_window(model: dict[str, Any]) -> int:
    configured = model.get("contextWindow") or model.get("context_window") or model.get("contextLength") or os.environ.get("MON_AGENT_CONTEXT_WINDOW")
    try:
        return int(configured)
    except (TypeError, ValueError):
        return 256000
