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
from .context import MonToolContext
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
_WEB_RESOURCES: dict[str, dict[str, dict[str, Any]]] = {}
_WEB_RESOURCES_LOCK = threading.Lock()
_WEB_RESOURCE_LIMIT = 128


def _resource_scope(context: MonToolContext) -> str:
    return context.session_id or context.operation_id or "unbound"


def _put_resource(context: MonToolContext, kind: str, value: dict[str, Any]) -> str:
    scope = _resource_scope(context)
    with _WEB_RESOURCES_LOCK:
        resources = _WEB_RESOURCES.setdefault(scope, {})
        prefix = "search" if kind == "search" else "page"
        next_index = 1 + max(
            (int(key.rsplit("_", 1)[1]) for key in resources if key.startswith(f"{prefix}_") and key.rsplit("_", 1)[1].isdigit()),
            default=0,
        )
        ref_id = f"{prefix}_{next_index}"
        resources[ref_id] = {"kind": kind, **deepcopy(value), "created_at": time.time()}
        while len(resources) > _WEB_RESOURCE_LIMIT:
            oldest = min(resources, key=lambda key: float(resources[key].get("created_at") or 0))
            resources.pop(oldest, None)
        return ref_id


def _get_resource(context: MonToolContext, ref_id: str) -> dict[str, Any]:
    with _WEB_RESOURCES_LOCK:
        resource = deepcopy(_WEB_RESOURCES.get(_resource_scope(context), {}).get(ref_id))
    if resource is None:
        raise ValueError(f"当前会话中不存在网页引用 {ref_id}")
    return resource


def clear_web_resources(session_id: str | None = None) -> None:
    with _WEB_RESOURCES_LOCK:
        if session_id is None:
            _WEB_RESOURCES.clear()
        else:
            _WEB_RESOURCES.pop(session_id, None)


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


def _search_term_key(value: Any) -> str:
    return re.sub(r"[^\w\u3040-\u30ff\u3400-\u9fff]+", "", str(value or "").casefold())


def _merge_search_results(searches: list[dict[str, Any]], max_results: int) -> dict[str, Any]:
    merged: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for search in searches:
        for item in search.get("results") or []:
            url_key = str(item.get("url") or "").split("#", 1)[0]
            title_key = _search_term_key(item.get("title"))
            if not url_key or url_key in seen_urls or (title_key and title_key in seen_titles):
                continue
            seen_urls.add(url_key)
            if title_key:
                seen_titles.add(title_key)
            merged.append(dict(item))
            if len(merged) >= max_results:
                break
        if len(merged) >= max_results:
            break
    for index, item in enumerate(merged, 1):
        item["id"] = f"source_{index}"
        item["source_id"] = f"source_{index}"
    providers = list(dict.fromkeys(str(item.get("provider") or "") for item in searches))
    return {
        "provider": providers[0] if len(providers) == 1 else "multi",
        "providers": providers,
        "endpoint": "",
        "results": merged,
        "elapsed_ms": max((int(item.get("elapsed_ms") or 0) for item in searches), default=0),
        "query": searches[0].get("query") if len(searches) == 1 else " | ".join(str(item.get("query") or "") for item in searches),
        "queries": [item.get("query") for item in searches],
        "attempts": {str(item.get("query") or ""): item.get("attempts") or [] for item in searches},
        "cached": all(bool(item.get("cached")) for item in searches),
    }


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


def create_web_tools(context: MonToolContext | None = None) -> list[AgentTool]:
    context = context or MonToolContext()

    async def web_execute(
        _tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        action = str(params.get("action") or "").strip().lower()
        if action == "open":
            ref_id = str(params.get("ref_id") or "").strip()
            url = str(params.get("url") or "").strip()
            if ref_id:
                resource = _get_resource(context, ref_id)
                url = str(resource.get("url") or "")
            if not url:
                raise ValueError("open 操作需要 ref_id 或 url")
            max_chars = min(max(int(round(float(params.get("max_chars") or 28_000))), 2_000), 60_000)
            total_timeout = _total_tool_timeout_seconds("MON_AGENT_FETCH_TOTAL_TIMEOUT_MS", 30_000)
            try:
                async with asyncio.timeout(total_timeout):
                    fetched = await asyncio.to_thread(fetch_web_page, url)
            except TimeoutError as error:
                raise RuntimeError(f"网页打开超时：目标页面未在 {total_timeout:g} 秒内返回。") from error
            body = truncate(
                f"{'标题: ' + fetched['title'] + chr(10) + chr(10) if fetched.get('title') else ''}{fetched['body']}",
                max_chars,
            )
            page_ref = _put_resource(context, "page", {"url": fetched["url"], "title": fetched.get("title"), "body": body})
            details = {
                "action": "open", "ref_id": page_ref, "provider": "direct", "final_url": fetched["url"],
                "content_type": fetched["contentType"], "max_chars": max_chars, "bytes": fetched["bytes"],
                "response_truncated": fetched["truncated"], "charset": fetched["charset"],
            }
            return text_result(f"[{page_ref}] {fetched['url']}\n\n{body}", details)

        if action == "find":
            ref_id = str(params.get("ref_id") or "").strip()
            pattern = str(params.get("pattern") or "").strip()
            if not ref_id or not pattern:
                raise ValueError("find 操作需要 ref_id 和 pattern")
            resource = _get_resource(context, ref_id)
            if resource.get("kind") != "page":
                raise ValueError("find 只能用于 open 返回的 page 引用")
            body = str(resource.get("body") or "")
            matches: list[str] = []
            for match in re.finditer(re.escape(pattern), body, flags=re.IGNORECASE):
                start = max(0, match.start() - 180)
                end = min(len(body), match.end() + 280)
                excerpt = re.sub(r"\s+", " ", body[start:end]).strip()
                if excerpt not in matches:
                    matches.append(excerpt)
                if len(matches) >= 10:
                    break
            text = f"在 [{ref_id}] 中找到 {len(matches)} 处匹配：{pattern}"
            if matches:
                text += "\n\n" + "\n\n".join(f"[{index}] {item}" for index, item in enumerate(matches, 1))
            return text_result(text, {"action": "find", "ref_id": ref_id, "pattern": pattern, "matches": matches})

        if action != "search":
            raise ValueError("action 只支持 search、open 或 find")

        max_results = min(max(int(round(float(params.get("max_results") or 5))), 1), 10)
        raw_queries = params.get("queries")
        queries = [str(params.get("query") or "").strip()]
        if isinstance(raw_queries, list):
            queries.extend(str(item).strip() for item in raw_queries)
        queries = list(dict.fromkeys(item for item in queries if item))[:4]
        if not queries:
            raise ValueError("query 或 queries 至少需要提供一条搜索查询")
        raw_domains = params.get("domains")
        domains = raw_domains if isinstance(raw_domains, list) else None
        total_timeout = _total_tool_timeout_seconds("MON_AGENT_SEARCH_TOTAL_TIMEOUT_MS", 30_000)
        try:
            async with asyncio.timeout(total_timeout):
                completed = await asyncio.gather(
                    *(
                        asyncio.to_thread(
                            web_search,
                            query,
                            max_results,
                            params.get("language"),
                            params.get("time_range"),
                            None,
                            domains,
                        )
                        for query in queries
                    ),
                    return_exceptions=True,
                )
                search_results = [item for item in completed if isinstance(item, dict)]
                query_errors = {
                    query: str(item)
                    for query, item in zip(queries, completed, strict=True)
                    if isinstance(item, BaseException)
                }
                if not search_results:
                    details = "; ".join(f"{query}: {error}" for query, error in query_errors.items())
                    raise RuntimeError(f"所有独立查询均失败：{details}")
                result = _merge_search_results(search_results, max_results)
                result["query_errors"] = query_errors
        except TimeoutError as error:
            raise RuntimeError(f"网页搜索总超时：所有搜索入口未在 {total_timeout:g} 秒内返回可用结果。") from error
        for item in result["results"]:
            item["ref_id"] = _put_resource(context, "search", item)
            item["source_id"] = item["ref_id"]
            item["id"] = item["ref_id"]
        result["action"] = "search"
        return text_result(truncate(_search_text(result), 20_000), result)

    return [
        AgentTool(
            name="web",
            label="网页",
            description=(
                "统一的网页研究工具。使用 search 搜索并获得当前会话内有效的 ref_id；使用 open 打开 ref_id 或公开 URL；"
                "使用 find 在已打开页面中定位文字。引用事实时保留结果的实际 URL。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["search", "open", "find"], "description": "要执行的网页操作。"},
                    "query": {
                        "type": "string",
                        "description": "search 的主要查询。",
                    },
                    "queries": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 3,
                        "description": "可选的独立补充查询。不同语言、别名或不同检索意图分别写成一条简短查询，工具会并行搜索并合并成功结果，单条失败不影响其他查询。",
                    },
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
                        "description": "由智能体按任务选择的域名白名单，例如 [\"docs.python.org\"]；无需白名单时省略。",
                    },
                    "ref_id": {"type": "string", "description": "search 或 open 返回的当前会话引用，供 open/find 使用。"},
                    "url": {"type": "string", "description": "open 可直接打开的公开 http/https URL。"},
                    "pattern": {"type": "string", "description": "find 要在页面中定位的文字。"},
                    "max_chars": {"type": "number", "description": "open 最多返回多少字符，默认 28000。"},
                },
                "required": ["action"],
            },
            execute=web_execute,
        ),
    ]


def html_title(value: str) -> str | None:
    return extract_html(value)[0]


__all__ = [
    "DEFAULT_SEARCH_PROVIDER",
    "SEARCH_PROVIDER_LABELS",
    "bing_freshness_filter",
    "clear_search_cache",
    "clear_web_resources",
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
