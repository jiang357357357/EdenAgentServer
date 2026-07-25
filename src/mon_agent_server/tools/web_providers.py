from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import html
import json
import os
import re
import time
from typing import Any, Protocol
import urllib.parse
import urllib.request


DEFAULT_SEARCH_PROVIDER = "auto"
SEARCH_PROVIDER_LABELS = {
    "brave": "Brave Search",
    "exa": "Exa",
    "tavily": "Tavily",
    "searxng": "SearXNG",
    "bing": "必应",
    "duckduckgo": "DuckDuckGo",
}
PROVIDER_ALIASES = {
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
    ordered.extend(configured)
    ordered.extend(("bing", "duckduckgo"))
    return list(dict.fromkeys(ordered))


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


def normalize_results(provider: str, raw_results: list[dict[str, Any]], max_results: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_results:
        url = str(raw.get("url") or "").strip()
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        canonical = parsed._replace(fragment="").geturl()
        if canonical in seen:
            continue
        seen.add(canonical)
        title = re.sub(r"\s+", " ", str(raw.get("title") or canonical)).strip()
        snippet = re.sub(r"\s+", " ", str(raw.get("snippet") or raw.get("content") or "")).strip()
        source_id = f"source_{len(results) + 1}"
        item: dict[str, Any] = {
            "id": source_id,
            "source_id": source_id,
            "title": title,
            "url": canonical,
            "snippet": snippet,
            "hostname": _hostname(canonical),
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


def _timed_response(provider: str, endpoint: str, started: float, results: list[dict[str, Any]], max_results: int) -> SearchResponse:
    return SearchResponse(
        provider=provider,
        endpoint=endpoint,
        results=normalize_results(provider, results, max_results),
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
        return _timed_response(self.name, endpoint, started, results, request.max_results)


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
        return _timed_response(self.name, endpoint, started, results, request.max_results)


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
        return _timed_response(self.name, endpoint, started, results, request.max_results)


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
        return _timed_response(self.name, endpoint, started, results, request.max_results)


def html_to_text(value: str) -> str:
    text = re.sub(r"<(script|style|noscript)\b[^>]*>[\s\S]*?</\1>", "\n", value, flags=re.I)
    text = re.sub(r"<(br|p|div|section|article|li|tr|h[1-6])\b[^>]*>", "\n", text, flags=re.I)
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
        params = {"q": query, "count": str(request.max_results), "setlang": language, "cc": "CN"}
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
        return _timed_response(self.name, endpoint, started, parse_bing_results(raw, request.max_results), request.max_results)


class DuckDuckGoSearchProvider:
    name = "duckduckgo"

    def configured(self) -> bool:
        return True

    def search(self, request: SearchRequest) -> SearchResponse:
        query = request.query
        if request.domains:
            query += " " + " OR ".join(f"site:{domain}" for domain in request.domains)
        params = {"q": query, "kl": request.language or "cn-zh", "kp": "-1"}
        if request.time_range:
            params["df"] = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(request.time_range, request.time_range)
        endpoint = "https://html.duckduckgo.com/html/"
        url = f"{endpoint}?{urllib.parse.urlencode(params)}"
        request_value = urllib.request.Request(
            url,
            headers={
                "accept": "text/html,application/xhtml+xml",
                "accept-language": request.language or "zh-CN,zh;q=0.9,en;q=0.6",
                "user-agent": "Mozilla/5.0 MonAgent/0.1",
            },
        )
        started = time.monotonic()
        with urllib.request.urlopen(request_value, timeout=search_timeout_seconds()) as response:
            raw = response.read().decode("utf-8", errors="replace")
        if re.search(r"anomalyDetectionBlock|detected an anomaly|captcha", raw, re.I):
            raise RuntimeError("DuckDuckGo 拒绝了本次搜索请求，可能是短时间请求过多或网络出口被限制。")
        return _timed_response(self.name, endpoint, started, parse_duck_results(raw, request.max_results), request.max_results)


def create_search_providers() -> dict[str, SearchProvider]:
    providers: list[SearchProvider] = [
        BraveSearchProvider(),
        ExaSearchProvider(),
        TavilySearchProvider(),
        SearxngSearchProvider(),
        BingSearchProvider(),
        DuckDuckGoSearchProvider(),
    ]
    return {provider.name: provider for provider in providers}
