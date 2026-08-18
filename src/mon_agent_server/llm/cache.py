from __future__ import annotations

import hashlib
import json
from typing import Any

from .tools import tool_payload


PREFIX_FINGERPRINT_VERSION = 1


def _digest(value: Any) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def cache_prefix_state(
    model: dict[str, Any],
    reasoning: str | None,
    system_prompt: str,
    tools: list[Any],
) -> dict[str, Any]:
    """Build a deterministic identity for the provider-cacheable request header."""
    # Object keys are canonicalized by _digest; array order intentionally stays
    # intact because provider prompt caches see tool-definition order.
    direct_tools = tool_payload(tools)
    components = {
        "provider": str(model.get("provider") or ""),
        "model": str(model.get("id") or ""),
        "api": str(model.get("api") or ""),
        "reasoning": str(reasoning or "off"),
        "system": _digest(system_prompt),
        "tools": _digest(direct_tools),
    }
    return {
        "version": PREFIX_FINGERPRINT_VERSION,
        "fingerprint": _digest({"version": PREFIX_FINGERPRINT_VERSION, **components}),
        "components": components,
    }


def advance_cache_prefix(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
) -> dict[str, Any]:
    previous = previous if isinstance(previous, dict) else {}
    previous_components = previous.get("components")
    previous_components = previous_components if isinstance(previous_components, dict) else {}
    current_components = current["components"]
    changed = [
        key for key in ("provider", "model", "api", "reasoning", "system", "tools")
        if previous_components.get(key) != current_components.get(key)
    ]
    if not previous.get("fingerprint"):
        reason = "initial"
        epoch = 0
    elif previous.get("fingerprint") == current.get("fingerprint"):
        reason = "stable"
        epoch = int(previous.get("epoch") or 0)
        changed = []
    else:
        reason = ",".join(changed) or "fingerprint"
        epoch = int(previous.get("epoch") or 0) + 1
    return {
        **current,
        "epoch": epoch,
        "invalidationReason": reason,
        "changedComponents": changed,
    }
