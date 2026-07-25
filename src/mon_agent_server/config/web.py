from __future__ import annotations

import os

from .monconfig import MonConfig


_SEARCH_ENV_KEYS = {
    "PROVIDER": "MON_AGENT_SEARCH_PROVIDER",
    "TIMEOUT_MS": "MON_AGENT_SEARCH_TIMEOUT_MS",
    "CACHE_TTL_SECONDS": "MON_AGENT_SEARCH_CACHE_TTL_SECONDS",
    "BRAVE_API_KEY": "BRAVE_SEARCH_API_KEY",
    "EXA_API_KEY": "EXA_API_KEY",
    "TAVILY_API_KEY": "TAVILY_API_KEY",
    "SEARXNG_URL": "MON_AGENT_SEARXNG_URL",
    "BRAVE_SEARCH_URL": "MON_AGENT_BRAVE_SEARCH_URL",
    "EXA_SEARCH_URL": "MON_AGENT_EXA_SEARCH_URL",
    "TAVILY_SEARCH_URL": "MON_AGENT_TAVILY_SEARCH_URL",
    "FETCH_TIMEOUT_MS": "MON_AGENT_FETCH_TIMEOUT_MS",
    "FETCH_MAX_BYTES": "MON_AGENT_FETCH_MAX_BYTES",
}


def publish_web_env_defaults(config: MonConfig) -> None:
    """Publish [search] values for the process without overriding explicit env vars."""
    for config_key, env_key in _SEARCH_ENV_KEYS.items():
        value = config.data.get("search", {}).get(config_key, "").strip()
        if value:
            os.environ.setdefault(env_key, value)


__all__ = ["publish_web_env_defaults"]
