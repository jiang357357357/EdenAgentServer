from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from difflib import SequenceMatcher
import html
import json
import os
import re
import threading
import time
from typing import Any, Protocol
import urllib.parse
import urllib.error
import urllib.request


DEFAULT_SEARCH_PROVIDER = "auto"
SEARCH_PROVIDER_LABELS = {
    "parallel_mcp": "Parallel Search MCP",
    "exa_mcp": "Exa Search MCP",
    "brave": "Brave Search",
    "exa": "Exa",
    "tavily": "Tavily",
    "searxng": "SearXNG",
    "bing": "必应",
    "duckduckgo": "DuckDuckGo",
}
PROVIDER_ALIASES = {
    "parallel": "parallel_mcp",
    "parallel-mcp": "parallel_mcp",
    "exa-mcp": "exa_mcp",
    "cn-bing": "bing",
    "ddg": "duckduckgo",
    "duck": "duckduckgo",
    "brave-search": "brave",
    "searx": "searxng",
}


@dataclass(frozen=True)
class SearchRequest:
    query: str
    max_results: int = 5
    language: str | None = None
    time_range: str | None = None
    domains: tuple[str, ...] = ()


@dataclass
class SearchResponse:
    provider: str
    endpoint: str
    results: list[dict[str, Any]]
    elapsed_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "endpoint": self.endpoint,
            "results": self.results,
            "elapsed_ms": self.elapsed_ms,
            **self.metadata,
        }


class SearchProvider(Protocol):
    name: str

    def configured(self) -> bool: ...

    def search(self, request: SearchRequest) -> SearchResponse: ...


def search_timeout_seconds() -> float:
    raw = os.environ.get("MON_AGENT_SEARCH_TIMEOUT_MS", "10000").strip()
    try:
        timeout_ms = int(raw)
    except ValueError:
        timeout_ms = 10_000
    return min(max(timeout_ms, 1_000), 60_000) / 1_000


def _first_env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _normalized_provider(value: str) -> str:
    normalized = value.strip().lower()
    return PROVIDER_ALIASES.get(normalized, normalized)


def search_provider_order(provider: str | None = None) -> list[str]:
    requested = provider if provider is not None else os.environ.get("MON_AGENT_SEARCH_PROVIDER", DEFAULT_SEARCH_PROVIDER)
    requested_names = [_normalized_provider(item) for item in str(requested or "auto").split(",") if item.strip()]
    requested_names = [item for item in requested_names if item in SEARCH_PROVIDER_LABELS or item == "auto"]

    configured: list[str] = []
    if _first_env("BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"):
        configured.append("brave")
    if _first_env("EXA_API_KEY"):
        configured.append("exa")
    if _first_env("TAVILY_API_KEY"):
        configured.append("tavily")
    if _first_env("MON_AGENT_SEARXNG_URL", "SEARXNG_URL"):
        configured.append("searxng")

    ordered = [item for item in requested_names if item != "auto"]
    if not ordered:
        ordered.extend(("parallel_mcp", "exa_mcp"))
    ordered.extend(configured)
    ordered.extend(("bing", "duckduckgo"))
    return list(dict.fromkeys(ordered))


_MCP_COOLDOWNS: dict[str, float] = {}
_MCP_COOLDOWNS_LOCK = threading.Lock()
_MCP_MAX_RESPONSE_BYTES = 256 * 1024


def _mcp_cooldown_seconds() -> int:
    raw = os.environ.get("MON_AGENT_SEARCH_MCP_COOLDOWN_SECONDS", "60").strip()
    try:
        return min(max(int(raw), 1), 3600)
    except ValueError:
        return 60


def _mcp_call(endpoint: str, tool: str, arguments: dict[str, Any], headers: dict[str, str] | None = None) -> str:
    with _MCP_COOLDOWNS_LOCK:
        retry_at = _MCP_COOLDOWNS.get(endpoint, 0)
    if retry_at > time.monotonic():
        raise RuntimeError(f"远程搜索服务处于限流冷却期，还需 {max(1, round(retry_at - time.monotonic()))} 秒")
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "user-agent": "MonAgent/0.1",
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=search_timeout_seconds()) as response:
            raw_bytes = response.read(_MCP_MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 429:
            with _MCP_COOLDOWNS_LOCK:
                _MCP_COOLDOWNS[endpoint] = time.monotonic() + _mcp_cooldown_seconds()
        message = error.read(1000).decode("utf-8", errors="replace")
        raise RuntimeError(f"远程 MCP 返回 HTTP {error.code}: {message[:500]}") from error
    if len(raw_bytes) > _MCP_MAX_RESPONSE_BYTES:
        raise RuntimeError(f"远程 MCP 响应超过 {_MCP_MAX_RESPONSE_BYTES} 字节限制")
    raw = raw_bytes.decode("utf-8", errors="replace").strip()
    candidates = [raw]
    candidates.extend(line[6:] for line in raw.splitlines() if line.startswith("data: "))
    envelope: dict[str, Any] | None = None
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and ("result" in parsed or "error" in parsed):
            envelope = parsed
            break
    if envelope is None:
        raise RuntimeError("远程 MCP 返回了无法解析的响应")
    if envelope.get("error"):
        raise RuntimeError(f"远程 MCP 调用失败: {envelope['error']}")
    result = envelope.get("result") if isinstance(envelope.get("result"), dict) else {}
    for item in result.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            return item["text"]
    raise RuntimeError("远程 MCP 没有返回文本搜索结果")


def _search_query_with_constraints(request: SearchRequest) -> str:
    query = request.query
    if request.domains:
        query += " " + " OR ".join(f"site:{domain}" for domain in request.domains)
    if request.time_range:
        query += f" 仅限最近{ {'day': '一天', 'week': '一周', 'month': '一个月', 'year': '一年'}[request.time_range] }"
    return query


def _parse_exa_mcp_text(value: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    pattern = re.compile(
        r"(?:^|\n)Title:\s*(?P<title>[^\n]+)\nURL:\s*(?P<url>[^\n]+)"
        r"(?:\nPublished:\s*(?P<published>[^\n]+))?(?:\nAuthor:[^\n]*)?(?:\nHighlights:\n(?P<body>.*?))?"
        r"(?=\nTitle:|\Z)",
        re.DOTALL,
    )
    for match in pattern.finditer(value):
        rows.append({
            "title": match.group("title").strip(),
            "url": match.group("url").strip(),
            "published_at": (match.group("published") or "").strip(),
            "snippet": re.sub(r"\s+", " ", (match.group("body") or "")).strip()[:4000],
        })
    return rows


class ParallelMcpSearchProvider:
    name = "parallel_mcp"

    def configured(self) -> bool:
        return True

    def search(self, request: SearchRequest) -> SearchResponse:
        endpoint = os.environ.get("MON_AGENT_PARALLEL_MCP_URL", "https://search.parallel.ai/mcp").strip()
        api_key = _first_env("PARALLEL_API_KEY")
        query = _search_query_with_constraints(request)
        started = time.monotonic()
        text = _mcp_call(
            endpoint,
            "web_search",
            {"objective": query, "search_queries": [query], "session_id": f"monagent-{abs(hash(query))}"},
            {"authorization": f"Bearer {api_key}"} if api_key else None,
        )
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise RuntimeError("Parallel MCP 返回的工具内容不是 JSON") from error
        results = []
        for row in payload.get("results") or []:
            if not isinstance(row, dict):
                continue
            excerpts = row.get("excerpts") if isinstance(row.get("excerpts"), list) else []
            results.append({
                "title": row.get("title"), "url": row.get("url"),
                "snippet": " ".join(str(item) for item in excerpts), "published_at": row.get("publish_date"),
            })
        return _timed_response(self.name, endpoint, started, results, request.max_results, request.query)


class ExaMcpSearchProvider:
    name = "exa_mcp"

    def configured(self) -> bool:
        return True

    def search(self, request: SearchRequest) -> SearchResponse:
        endpoint = os.environ.get("MON_AGENT_EXA_MCP_URL", "https://mcp.exa.ai/mcp").strip()
        api_key = _first_env("EXA_API_KEY")
        started = time.monotonic()
        text = _mcp_call(
            endpoint,
            "web_search_exa",
            {
                "query": _search_query_with_constraints(request), "type": "auto",
                "numResults": request.max_results, "livecrawl": "fallback", "contextMaxCharacters": 12_000,
            },
            {"x-api-key": api_key} if api_key else None,
        )
        return _timed_response(
            self.name, endpoint, started, _parse_exa_mcp_text(text), request.max_results, request.query
        )


def _json_request(url: str, *, headers: dict[str, str] | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_headers = {"accept": "application/json", "user-agent": "MonAgent/0.1", **(headers or {})}
    if body is not None:
        request_headers.setdefault("content-type", "application/json")
    request = urllib.request.Request(url, data=body, headers=request_headers, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(request, timeout=search_timeout_seconds()) as response:
        raw = response.read()
    value = json.loads(raw.decode("utf-8", errors="replace"))
    if not isinstance(value, dict):
        raise RuntimeError("搜索服务返回了无效的 JSON 结构")
    return value


def _hostname(url: str) -> str:
    return urllib.parse.urlparse(url).hostname or ""


def _result_text_key(value: Any) -> str:
    return re.sub(r"[^\w\u3400-\u9fff]+", "", str(value or "").casefold())


def _is_near_duplicate_title(title_key: str, seen_title_keys: list[str]) -> bool:
    if not title_key:
        return False
    return any(
        title_key == seen
        or (min(len(title_key), len(seen)) >= 8 and SequenceMatcher(None, title_key, seen).ratio() >= 0.92)
        for seen in seen_title_keys
    )


def normalize_results(
    provider: str,
    raw_results: list[dict[str, Any]],
    max_results: int,
    query: str | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_title_keys: list[str] = []
    host_counts: dict[str, int] = {}
    query_key = _result_text_key(query)
    ranked_results = sorted(
        enumerate(raw_results),
        key=lambda pair: (
            -int(bool(query_key and query_key in _result_text_key(pair[1].get("title")))),
            pair[0],
        ),
    )
    for _, raw in ranked_results:
        url = str(raw.get("url") or "").strip()
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        canonical = parsed._replace(fragment="", query=urllib.parse.urlencode([
            (key, value)
            for key, values in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()
            if not key.lower().startswith("utm_") and key.lower() not in {"spm", "from", "source"}
            for value in values
        ])).geturl()
        if canonical in seen:
            continue
        title = re.sub(r"\s+", " ", str(raw.get("title") or canonical)).strip()
        title_key = _result_text_key(title)
        if _is_near_duplicate_title(title_key, seen_title_keys):
            continue
        hostname = _hostname(canonical).lower()
        if host_counts.get(hostname, 0) >= 2:
            continue
        seen.add(canonical)
        if title_key:
            seen_title_keys.append(title_key)
        host_counts[hostname] = host_counts.get(hostname, 0) + 1
        snippet = re.sub(r"\s+", " ", str(raw.get("snippet") or raw.get("content") or "")).strip()
        source_id = f"source_{len(results) + 1}"
        item: dict[str, Any] = {
            "id": source_id,
            "source_id": source_id,
            "title": title,
            "url": canonical,
            "snippet": snippet,
            "hostname": hostname,
            "provider": provider,
        }
        published_at = raw.get("published_at") or raw.get("publishedDate") or raw.get("published_date")
        if published_at:
            item["published_at"] = str(published_at)
        score = raw.get("score")
        if isinstance(score, (int, float)):
            item["score"] = float(score)
        content = raw.get("full_content") or raw.get("raw_content") or raw.get("text")
        if content:
            item["content"] = str(content)
        results.append(item)
        if len(results) >= max_results:
            break
    return results


def _timed_response(
    provider: str,
    endpoint: str,
    started: float,
    results: list[dict[str, Any]],
    max_results: int,
    query: str | None = None,
) -> SearchResponse:
    return SearchResponse(
        provider=provider,
        endpoint=endpoint,
        results=normalize_results(provider, results, max_results, query),
        elapsed_ms=max(0, round((time.monotonic() - started) * 1000)),
    )


class BraveSearchProvider:
    name = "brave"

    def configured(self) -> bool:
        return bool(_first_env("BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"))

    def search(self, request: SearchRequest) -> SearchResponse:
        api_key = _first_env("BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY")
        if not api_key:
            raise RuntimeError("未配置 BRAVE_SEARCH_API_KEY")
        endpoint = os.environ.get("MON_AGENT_BRAVE_SEARCH_URL", "https://api.search.brave.com/res/v1/web/search").strip()
        query = request.query
        if request.domains:
            query += " " + " OR ".join(f"site:{domain}" for domain in request.domains)
        params: dict[str, str] = {"q": query, "count": str(request.max_results), "safesearch": "moderate"}
        if request.language:
            params["search_lang"] = request.language.split("-")[0].lower()
        if request.time_range:
            params["freshness"] = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}.get(request.time_range, request.time_range)
        url = f"{endpoint}?{urllib.parse.urlencode(params)}"
        started = time.monotonic()
        value = _json_request(url, headers={"X-Subscription-Token": api_key})
        rows = value.get("web", {}).get("results", []) if isinstance(value.get("web"), dict) else []
        results = [
            {
                "title": row.get("title"),
                "url": row.get("url"),
                "snippet": row.get("description"),
                "published_at": row.get("page_age") or row.get("age"),
            }
            for row in rows
            if isinstance(row, dict)
        ]
        return _timed_response(self.name, endpoint, started, results, request.max_results, request.query)


class ExaSearchProvider:
    name = "exa"

    def configured(self) -> bool:
        return bool(_first_env("EXA_API_KEY"))

    def search(self, request: SearchRequest) -> SearchResponse:
        api_key = _first_env("EXA_API_KEY")
        if not api_key:
            raise RuntimeError("未配置 EXA_API_KEY")
        endpoint = os.environ.get("MON_AGENT_EXA_SEARCH_URL", "https://api.exa.ai/search").strip()
        payload: dict[str, Any] = {
            "query": request.query,
            "numResults": request.max_results,
            "type": "auto",
            "contents": {"highlights": {"maxCharacters": 1200}},
        }
        if request.domains:
            payload["includeDomains"] = list(request.domains)
        if request.time_range:
            days = {"day": 1, "week": 7, "month": 30, "year": 365}.get(request.time_range)
            if days:
                since = datetime.now(timezone.utc) - timedelta(days=days)
                payload["startPublishedDate"] = since.isoformat(timespec="seconds").replace("+00:00", "Z")
        started = time.monotonic()
        value = _json_request(endpoint, headers={"x-api-key": api_key}, payload=payload)
        results = []
        for row in value.get("results", []):
            if not isinstance(row, dict):
                continue
            highlights = row.get("highlights") if isinstance(row.get("highlights"), list) else []
            results.append(
                {
                    "title": row.get("title"),
                    "url": row.get("url"),
                    "snippet": " ".join(str(item) for item in highlights) or row.get("text"),
                    "published_at": row.get("publishedDate"),
                    "score": row.get("score"),
                }
            )
        return _timed_response(self.name, endpoint, started, results, request.max_results, request.query)


class TavilySearchProvider:
    name = "tavily"

    def configured(self) -> bool:
        return bool(_first_env("TAVILY_API_KEY"))

    def search(self, request: SearchRequest) -> SearchResponse:
        api_key = _first_env("TAVILY_API_KEY")
        if not api_key:
            raise RuntimeError("未配置 TAVILY_API_KEY")
        endpoint = os.environ.get("MON_AGENT_TAVILY_SEARCH_URL", "https://api.tavily.com/search").strip()
        payload: dict[str, Any] = {
            "query": request.query,
            "max_results": request.max_results,
            "search_depth": "basic",
            "include_answer": False,
            "include_raw_content": False,
        }
        if request.domains:
            payload["include_domains"] = list(request.domains)
        if request.time_range:
            payload["time_range"] = request.time_range
        started = time.monotonic()
        value = _json_request(endpoint, headers={"Authorization": f"Bearer {api_key}"}, payload=payload)
        results = [
            {
                "title": row.get("title"),
                "url": row.get("url"),
                "snippet": row.get("content"),
                "published_at": row.get("published_date"),
                "score": row.get("score"),
                "raw_content": row.get("raw_content"),
            }
            for row in value.get("results", [])
            if isinstance(row, dict)
        ]
        return _timed_response(self.name, endpoint, started, results, request.max_results, request.query)


class SearxngSearchProvider:
    name = "searxng"

    def configured(self) -> bool:
        return bool(_first_env("MON_AGENT_SEARXNG_URL", "SEARXNG_URL"))

    def search(self, request: SearchRequest) -> SearchResponse:
        endpoint = _first_env("MON_AGENT_SEARXNG_URL", "SEARXNG_URL").rstrip("/")
        if not endpoint:
            raise RuntimeError("未配置 MON_AGENT_SEARXNG_URL")
        query = request.query
        if request.domains:
            query += " " + " OR ".join(f"site:{domain}" for domain in request.domains)
        params = {"q": query, "format": "json", "safesearch": "1"}
        if request.language:
            params["language"] = request.language
        if request.time_range:
            params["time_range"] = request.time_range
        url = f"{endpoint}/search?{urllib.parse.urlencode(params)}"
        started = time.monotonic()
        value = _json_request(url)
        results = [
            {
                "title": row.get("title"),
                "url": row.get("url"),
                "snippet": row.get("content"),
                "published_at": row.get("publishedDate"),
                "score": row.get("score"),
            }
            for row in value.get("results", [])
            if isinstance(row, dict)
        ]
        return _timed_response(self.name, endpoint, started, results, request.max_results, request.query)


def html_to_text(value: str) -> str:
    text = re.sub(r"<(script|style|noscript)\b[^>]*>[\s\S]*?</\1>", "\n", value, flags=re.I)
    text = re.sub(r"<(br|p|div|section|article|li|tr|h[1-6])\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"</?(strong|b|em|i|mark|span)\b[^>]*>", "", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def normalize_duck_url(raw_url: str) -> str:
    decoded = html.unescape(raw_url.strip())
    if decoded.startswith("//"):
        decoded = f"https:{decoded}"
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(decoded).query)
        if query.get("uddg"):
            return query["uddg"][0]
    except Exception:
        pass
    return decoded


def normalize_bing_url(raw_url: str) -> str:
    decoded = html.unescape(raw_url.strip())
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(decoded).query)
        encoded = (query.get("u") or [""])[0]
        if encoded.startswith("a1"):
            value = encoded[2:] + "=" * (-len(encoded[2:]) % 4)
            target = base64.urlsafe_b64decode(value).decode("utf-8", errors="replace")
            if urllib.parse.urlparse(target).scheme in {"http", "https"}:
                return target
    except (ValueError, UnicodeDecodeError):
        pass
    return decoded


def parse_bing_results(raw: str, max_results: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for block in re.split(r'<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>', raw, flags=re.I)[1:]:
        title_match = re.search(r'<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>\s*</h2>', block, re.I)
        if not title_match:
            continue
        url = normalize_bing_url(title_match.group(1))
        snippet_match = re.search(r'<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)</p>', block, re.I)
        host_match = re.search(r'<cite\b[^>]*>([\s\S]*?)</cite>', block, re.I)
        results.append(
            {
                "title": re.sub(r"\s+", " ", html_to_text(title_match.group(2))).strip(),
                "url": url,
                "snippet": re.sub(r"\s+", " ", html_to_text(snippet_match.group(1))).strip() if snippet_match else "",
                "hostname": re.sub(r"\s+", " ", html_to_text(host_match.group(1))).strip() if host_match else _hostname(url),
            }
        )
        if len(results) >= max_results:
            break
    return results


def parse_duck_results(raw: str, max_results: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for block in re.split(r'<div class="result results_links', raw, flags=re.I)[1:]:
        title_match = re.search(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>', block, re.I)
        if not title_match:
            continue
        url = normalize_duck_url(title_match.group(1))
        snippet_match = re.search(r'<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)</a>', block, re.I)
        host_match = re.search(r'<a[^>]+class="result__url"[^>]*>([\s\S]*?)</a>', block, re.I)
        results.append(
            {
                "title": re.sub(r"\s+", " ", html_to_text(title_match.group(2))).strip(),
                "url": url,
                "snippet": re.sub(r"\s+", " ", html_to_text(snippet_match.group(1))).strip() if snippet_match else "",
                "hostname": re.sub(r"\s+", " ", html_to_text(host_match.group(1))).strip() if host_match else _hostname(url),
            }
        )
        if len(results) >= max_results:
            break
    return results


def parse_duck_lite_results(raw: str, max_results: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    links = list(
        re.finditer(
            r'<a\b[^>]*class=["\'][^"\']*\bresult-link\b[^"\']*["\'][^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',
            raw,
            re.I,
        )
    )
    for index, match in enumerate(links):
        block_end = links[index + 1].start() if index + 1 < len(links) else len(raw)
        block = raw[match.end() : block_end]
        snippet_match = re.search(
            r'<td\b[^>]*class=["\'][^"\']*\bresult-snippet\b[^"\']*["\'][^>]*>([\s\S]*?)</td>',
            block,
            re.I,
        )
        url = normalize_duck_url(match.group(1))
        results.append(
            {
                "title": re.sub(r"\s+", " ", html_to_text(match.group(2))).strip(),
                "url": url,
                "snippet": re.sub(r"\s+", " ", html_to_text(snippet_match.group(1))).strip() if snippet_match else "",
                "hostname": _hostname(url),
            }
        )
        if len(results) >= max_results:
            break
    return results


def bing_freshness_filter(time_range: str | None, today: date | None = None) -> str | None:
    fixed = {"day": 'ex1:"ez1"', "week": 'ex1:"ez2"', "month": 'ex1:"ez3"'}
    if time_range in fixed:
        return fixed[time_range]
    if time_range != "year":
        return None
    current = today or date.today()
    epoch = date(1970, 1, 1)
    end_day = (current - epoch).days
    return f'ex1:"ez5_{end_day - 365}_{end_day}"'


class BingSearchProvider:
    name = "bing"

    def configured(self) -> bool:
        return True

    def search(self, request: SearchRequest) -> SearchResponse:
        language = (request.language or "zh-CN").strip()
        if language.lower() in {"cn-zh", "zh-cn", "zh-hans"}:
            language = "zh-Hans"
        query = request.query
        if request.domains:
            query += " " + " OR ".join(f"site:{domain}" for domain in request.domains)
        candidate_count = min(request.max_results * 3, 30)
        params = {"q": query, "count": str(candidate_count), "setlang": language, "cc": "CN"}
        freshness = bing_freshness_filter(request.time_range)
        if freshness:
            params["filters"] = freshness
        endpoint = "https://cn.bing.com/search"
        url = f"{endpoint}?{urllib.parse.urlencode(params)}"
        request_value = urllib.request.Request(
            url,
            headers={"accept": "text/html,application/xhtml+xml", "accept-language": language, "user-agent": "Mozilla/5.0 MonAgent/0.1"},
        )
        started = time.monotonic()
        with urllib.request.urlopen(request_value, timeout=search_timeout_seconds()) as response:
            raw = response.read().decode("utf-8", errors="replace")
        return _timed_response(
            self.name,
            endpoint,
            started,
            parse_bing_results(raw, candidate_count),
            request.max_results,
            request.query,
        )


class DuckDuckGoSearchProvider:
    name = "duckduckgo"
    _cooldown_lock = threading.Lock()
    _blocked_until = 0.0

    def configured(self) -> bool:
        return True

    @classmethod
    def _cooldown_seconds(cls) -> int:
        try:
            value = int(os.environ.get("MON_AGENT_DUCKDUCKGO_COOLDOWN_SECONDS", "900"))
        except ValueError:
            value = 900
        return min(max(value, 0), 86_400)

    @classmethod
    def _remaining_cooldown(cls) -> int:
        with cls._cooldown_lock:
            return max(0, round(cls._blocked_until - time.monotonic()))

    @classmethod
    def _start_cooldown(cls) -> None:
        with cls._cooldown_lock:
            cls._blocked_until = time.monotonic() + cls._cooldown_seconds()

    @classmethod
    def clear_cooldown(cls) -> None:
        with cls._cooldown_lock:
            cls._blocked_until = 0.0

    @staticmethod
    def _post(endpoint: str, params: dict[str, str]) -> tuple[int, str]:
        request_value = urllib.request.Request(
            endpoint,
            data=urllib.parse.urlencode(params).encode("utf-8"),
            method="POST",
            headers={
                "accept": "text/html,application/xhtml+xml",
                "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
            },
        )
        proxy = os.environ.get("MON_AGENT_DUCKDUCKGO_PROXY", "").strip()
        if proxy:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
            response_context = opener.open(request_value, timeout=search_timeout_seconds())
        else:
            response_context = urllib.request.urlopen(request_value, timeout=search_timeout_seconds())
        with response_context as response:
            return getattr(response, "status", 200), response.read().decode("utf-8", errors="replace")

    def search(self, request: SearchRequest) -> SearchResponse:
        remaining = self._remaining_cooldown()
        if remaining:
            raise RuntimeError(f"DuckDuckGo 正处于反自动化冷却期，约 {remaining} 秒后再试。")
        query = request.query
        if request.domains:
            query += " " + " OR ".join(f"site:{domain}" for domain in request.domains)
        params = {"q": query, "kl": request.language or "cn-zh", "kp": "-1"}
        if request.time_range:
            params["df"] = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(request.time_range, request.time_range)
        started = time.monotonic()
        endpoints = (
            ("https://html.duckduckgo.com/html/", parse_duck_results),
            ("https://lite.duckduckgo.com/lite/", parse_duck_lite_results),
        )
        failures: list[str] = []
        for endpoint, parser in endpoints:
            status, raw = self._post(endpoint, params)
            if status == 202 or re.search(r"anomalyDetectionBlock|detected an anomaly|captcha", raw, re.I):
                failures.append(f"{endpoint} 返回挑战页（HTTP {status}）")
                continue
            if status != 200:
                failures.append(f"{endpoint} 返回 HTTP {status}")
                continue
            parsed = parser(raw, min(request.max_results * 3, 30))
            if parsed or re.search(r"No results|没有找到", raw, re.I):
                return SearchResponse(
                    provider=self.name,
                    endpoint=endpoint,
                    results=normalize_results(self.name, parsed, request.max_results, request.query),
                    elapsed_ms=max(0, round((time.monotonic() - started) * 1000)),
                    metadata={"backend": "lite" if "lite." in endpoint else "html"},
                )
            failures.append(f"{endpoint} 返回非标准结果页")
        self._start_cooldown()
        raise RuntimeError("DuckDuckGo HTML/Lite 均不可用，已进入冷却期：" + "; ".join(failures))


def create_search_providers() -> dict[str, SearchProvider]:
    providers: list[SearchProvider] = [
        ParallelMcpSearchProvider(),
        ExaMcpSearchProvider(),
        BraveSearchProvider(),
        ExaSearchProvider(),
        TavilySearchProvider(),
        SearxngSearchProvider(),
        BingSearchProvider(),
        DuckDuckGoSearchProvider(),
    ]
    return {provider.name: provider for provider in providers}
