from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


DELEGATION_MODES = ("disabled", "explicit", "auto", "proactive")


@dataclass(frozen=True, slots=True)
class DelegationPolicy:
    mode: str = "auto"

    @classmethod
    def from_environment(cls) -> "DelegationPolicy":
        mode = str(os.environ.get("MON_AGENT_DELEGATION_MODE") or "auto").strip().lower()
        if mode not in DELEGATION_MODES:
            mode = "auto"
        return cls(mode=mode)


class RuntimeModelConfig:
    def __init__(self, model: dict[str, Any], api_key: str | None, label: str, source: str, core: dict[str, Any] | None) -> None:
        self.model = model
        self.api_key = api_key
        self.label = label
        self.source = source
        self.core = core
        self.supports_images = "image" in (model.get("input") or [])
        self.thinking_level = "medium" if model.get("reasoning") else "off"
        self.delegation_policy = DelegationPolicy.from_environment()


def runtime_context_window(model: dict[str, Any]) -> int:
    configured = model.get("contextWindow") or model.get("context_window") or model.get("contextLength") or os.environ.get("MON_AGENT_CONTEXT_WINDOW")
    try:
        return int(configured)
    except (TypeError, ValueError):
        return 256000
