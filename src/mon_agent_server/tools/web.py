from __future__ import annotations

import asyncio
from copy import deepcopy
import os
import re
import threading
import time
from typing import Any
from urllib.parse import urlparse

from mon_agent_core import AgentTool

from .result import text_result, truncate
from .web_fetcher import extract_html, fetch_web_page
from .web_providers import (
    DEFAULT_SEARCH_PROVIDER,
    SEARCH_PROVIDER_LABELS,
    SearchRequest,
    bing_freshness_filter,
    create_search_providers,
    html_to_text,
    normalize_bing_url,
    normalize_duck_url,
    parse_bing_results,
    parse_duck_results,
    search_provider_order,
    search_timeout_seconds,
)


_SEARCH_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
_SEARCH_CACHE_LOCK = threading.Lock()


def _total_tool_timeout_seconds(env_name: str, default_ms: int) -> float:
    raw = os.environ.get(env_name, str(default_ms)).strip()
    try:
        timeout_ms = int(raw)
    except ValueError:
        timeout_ms = default_ms
    return min(max(timeout_ms, 1_000), 120_000) / 1_000


def _cache_ttl_seconds() -> int:
    raw = os.environ.get("MON_AGENT_SEARCH_CACHE_TTL_SECONDS", "120").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 120
    return min(max(value, 0), 3600)


def clear_search_cache() -> None:
    with _SEARCH_CACHE_LOCK:
        _SEARCH_CACHE.clear()


def _cache_get(key: tuple[Any, ...]) -> dict[str, Any] | None:
    ttl = _cache_ttl_seconds()
    if ttl <= 0:
        return None
    now = time.monotonic()
    with _SEARCH_CACHE_LOCK:
        cached = _SEARCH_CACHE.get(key)
        if not cached:
            return None
        created_at, value = cached
        if now - created_at > ttl:
            _SEARCH_CACHE.pop(key, None)
            return None
        result = deepcopy(value)
    result["cached"] = True
    return result


def _cache_put(key: tuple[Any, ...], value: dict[str, Any]) -> None:
    if _cache_ttl_seconds() <= 0:
        return
    with _SEARCH_CACHE_LOCK:
        _SEARCH_CACHE[key] = (time.monotonic(), deepcopy(value))
        if len(_SEARCH_CACHE) > 128:
            oldest = min(_SEARCH_CACHE, key=lambda item: _SEARCH_CACHE[item][0])
            _SEARCH_CACHE.pop(oldest, None)


def _normalized_domains(domains: list[str] | tuple[str, ...] | None) -> tuple[str, ...]:
    normalized: list[str] = []
    for value in domains or ():
        domain = str(value).strip().lower()
        if domain.startswith("http://") or domain.startswith("https://"):
            domain = urlparse(domain).hostname or ""
        domain = domain.strip(".")
        try:
            domain = domain.encode("idna").decode("ascii")
        except UnicodeError:
            continue
        labels = domain.split(".")
        if len(domain) > 253 or not all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
        ):
            continue
        if domain and domain not in normalized:
            normalized.append(domain)
    return tuple(normalized[:20])


def web_search(
    query: str,
    max_results: int = 5,
    language: str | None = None,
    time_range: str | None = None,
    provider: str | None = None,
    domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    normalized_query = str(query).strip()
    if not normalized_query:
        raise ValueError("搜索关键词不能为空")
    normalized_max_results = min(max(int(max_results), 1), 10)
    normalized_time_range = str(time_range).strip().lower() if time_range else None
    if normalized_time_range not in {None, "day", "week", "month", "year"}:
        raise ValueError("time_range 只支持 day、week、month 或 year")
    request = SearchRequest(
        query=normalized_query,
        max_results=normalized_max_results,
        language=str(language).strip() if language else None,
        time_range=normalized_time_range,
        domains=_normalized_domains(domains),
    )
    order = search_provider_order(provider)
    cache_key = (request.query, request.max_results, request.language, request.time_range, request.domains, tuple(order))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    providers = create_search_providers()
    attempts: list[dict[str, Any]] = []
    for provider_name in order:
        search_provider = providers.get(provider_name)
        if search_provider is None:
            attempts.append({"provider": provider_name, "error": "未知的搜索提供商"})
            continue
        try:
            response = search_provider.search(request)
            if not response.results:
                raise RuntimeError("搜索服务未返回可用结果")
            result = {
                **response.as_dict(),
                "query": request.query,
                "attempts": attempts,
                "cached": False,
            }
            _cache_put(cache_key, result)
            return result
        except Exception as error:
            attempts.append({"provider": provider_name, "error": str(error), "error_type": type(error).__name__})

    details = "; ".join(
        f"{SEARCH_PROVIDER_LABELS.get(item['provider'], item['provider'])}: {item['error']}" for item in attempts
    )
    raise RuntimeError(f"所有网页搜索入口均不可用：{details}")


def _search_text(result: dict[str, Any]) -> str:
    provider_label = SEARCH_PROVIDER_LABELS.get(result["provider"], result["provider"])
    cache_suffix = "（缓存）" if result.get("cached") else ""
    lines = [f"{provider_label}搜索结果{cache_suffix}：{result.get('query', '')}"]
    for item in result["results"]:
        source_id = item.get("source_id") or item.get("id") or "source"
        fields = [
            f"[{source_id}] {item.get('title')}",
            f"URL: {item.get('url')}",
        ]
        if item.get("snippet"):
            fields.append(f"摘要: {item['snippet']}")
        if item.get("published_at"):
            fields.append(f"发布时间: {item['published_at']}")
        if item.get("hostname"):
            fields.append(f"来源: {item['hostname']}")
        lines.append("\n".join(fields))
    return "\n\n".join(lines)


def create_web_tools() -> list[AgentTool]:
    async def web_search_execute(
        _tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        max_results = min(max(int(round(float(params.get("max_results") or 5))), 1), 10)
        raw_domains = params.get("domains")
        domains = raw_domains if isinstance(raw_domains, list) else None
        total_timeout = _total_tool_timeout_seconds("MON_AGENT_SEARCH_TOTAL_TIMEOUT_MS", 30_000)
        try:
            async with asyncio.timeout(total_timeout):
                result = await asyncio.to_thread(
                    web_search,
                    str(params["query"]),
                    max_results,
                    params.get("language"),
                    params.get("time_range"),
                    None,
                    domains,
                )
        except TimeoutError as error:
            raise RuntimeError(f"网页搜索总超时：所有搜索入口未在 {total_timeout:g} 秒内返回可用结果。") from error
        return text_result(truncate(_search_text(result), 20_000), result)

    async def web_fetch_execute(
        _tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        max_chars = min(max(int(round(float(params.get("max_chars") or 28_000))), 2_000), 60_000)
        total_timeout = _total_tool_timeout_seconds("MON_AGENT_FETCH_TOTAL_TIMEOUT_MS", 30_000)
        try:
            async with asyncio.timeout(total_timeout):
                result = await asyncio.to_thread(fetch_web_page, str(params["url"]))
        except TimeoutError as error:
            raise RuntimeError(f"网页抓取总超时：目标页面未在 {total_timeout:g} 秒内返回。") from error
        body = truncate(
            f"{'标题: ' + result['title'] + chr(10) + chr(10) if result.get('title') else ''}{result['body']}",
            max_chars,
        )
        details = {
            "provider": "direct",
            "final_url": result["url"],
            "content_type": result["contentType"],
            "max_chars": max_chars,
            "bytes": result["bytes"],
            "response_truncated": result["truncated"],
            "charset": result["charset"],
        }
        return text_result(body, details)

    return [
        AgentTool(
            name="web_search",
            label="网页搜索",
            description=(
                "搜索实时网页信息并返回带 source_id 的结构化来源。自动优先使用已配置的 Brave、Exa、Tavily 或 "
                "SearXNG，失败时降级到必应和 DuckDuckGo。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词。"},
                    "max_results": {"type": "number", "description": "最多返回多少条结果，默认 5，最大 10。"},
                    "language": {"type": "string", "description": "搜索语言或地区，例如 zh-CN、en-US。"},
                    "time_range": {
                        "type": "string",
                        "enum": ["day", "week", "month", "year"],
                        "description": "只搜索指定时间范围内的内容。",
                    },
                    "domains": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选的域名白名单，例如 [\"docs.python.org\"]。",
                    },
                },
                "required": ["query"],
            },
            execute=web_search_execute,
        ),
        AgentTool(
            name="web_fetch",
            label="网页抓取",
            description="安全抓取公开网页，校验重定向并提取适合阅读的正文；不允许访问本机或私网地址。",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要抓取的公开 http/https 网页 URL。"},
                    "max_chars": {"type": "number", "description": "最多返回多少字符，默认 28000。"},
                },
                "required": ["url"],
            },
            execute=web_fetch_execute,
        ),
    ]


def html_title(value: str) -> str | None:
    return extract_html(value)[0]


__all__ = [
    "DEFAULT_SEARCH_PROVIDER",
    "SEARCH_PROVIDER_LABELS",
    "bing_freshness_filter",
    "clear_search_cache",
    "create_web_tools",
    "fetch_web_page",
    "html_title",
    "html_to_text",
    "normalize_bing_url",
    "normalize_duck_url",
    "parse_bing_results",
    "parse_duck_results",
    "search_provider_order",
    "search_timeout_seconds",
    "web_search",
]
