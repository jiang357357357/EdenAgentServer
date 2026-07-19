from __future__ import annotations

import asyncio
import base64
from datetime import date
import html
import os
import re
import urllib.parse
import urllib.request
from typing import Any

from mon_agent_core import AgentTool

from .result import text_result, truncate


DEFAULT_SEARCH_PROVIDER = "bing"
SEARCH_PROVIDER_LABELS = {
    "bing": "必应",
    "duckduckgo": "DuckDuckGo",
}


def search_timeout_seconds() -> float:
    raw = os.environ.get("MON_AGENT_SEARCH_TIMEOUT_MS", "10000").strip()
    try:
        timeout_ms = int(raw)
    except ValueError:
        timeout_ms = 10_000
    return min(max(timeout_ms, 1_000), 60_000) / 1_000


def search_provider_order(provider: str | None = None) -> list[str]:
    preferred = (provider or os.environ.get("MON_AGENT_SEARCH_PROVIDER") or DEFAULT_SEARCH_PROVIDER).strip().lower()
    aliases = {"cn-bing": "bing", "ddg": "duckduckgo", "duck": "duckduckgo"}
    preferred = aliases.get(preferred, preferred)
    if preferred not in SEARCH_PROVIDER_LABELS:
        preferred = DEFAULT_SEARCH_PROVIDER
    return [preferred, *[name for name in SEARCH_PROVIDER_LABELS if name != preferred]]


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


def html_to_text(value: str) -> str:
    text = re.sub(r"<(script|style|noscript)\b[^>]*>[\s\S]*?</\1>", "\n", value, flags=re.I)
    text = re.sub(r"<(br|p|div|section|article|li|tr|h[1-6])\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def html_title(value: str) -> str | None:
    match = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", value, re.I)
    if not match:
        return None
    return html.unescape(re.sub(r"<[^>]+>", " ", match.group(1)).strip())


def normalize_duck_url(raw_url: str) -> str:
    decoded = html.unescape(raw_url.strip())
    if decoded.startswith("//"):
        decoded = f"https:{decoded}"
    try:
        parsed = urllib.parse.urlparse(decoded)
        query = urllib.parse.parse_qs(parsed.query)
        if query.get("uddg"):
            return query["uddg"][0]
    except Exception:
        pass
    return decoded


def normalize_bing_url(raw_url: str) -> str:
    decoded = html.unescape(raw_url.strip())
    try:
        parsed = urllib.parse.urlparse(decoded)
        query = urllib.parse.parse_qs(parsed.query)
        encoded = (query.get("u") or [""])[0]
        if encoded.startswith("a1"):
            value = encoded[2:]
            value += "=" * (-len(value) % 4)
            target = base64.urlsafe_b64decode(value).decode("utf-8", errors="replace")
            if urllib.parse.urlparse(target).scheme in {"http", "https"}:
                return target
    except (ValueError, UnicodeDecodeError):
        pass
    return decoded


def parse_bing_results(raw: str, max_results: int) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for block in re.split(r'<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>', raw, flags=re.I)[1:]:
        title_match = re.search(r'<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>\s*</h2>', block, re.I)
        if not title_match:
            continue
        title = re.sub(r"\s+", " ", html_to_text(title_match.group(2))).strip()
        url = normalize_bing_url(title_match.group(1))
        if not title or urllib.parse.urlparse(url).scheme not in {"http", "https"}:
            continue
        snippet_match = re.search(r'<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)</p>', block, re.I)
        host_match = re.search(r'<cite\b[^>]*>([\s\S]*?)</cite>', block, re.I)
        results.append(
            {
                "title": title,
                "url": url,
                "snippet": re.sub(r"\s+", " ", html_to_text(snippet_match.group(1))).strip() if snippet_match else "",
                "hostname": re.sub(r"\s+", " ", html_to_text(host_match.group(1))).strip() if host_match else (urllib.parse.urlparse(url).hostname or ""),
            }
        )
        if len(results) >= max_results:
            break
    return results


def parse_duck_results(raw: str, max_results: int) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for block in re.split(r'<div class="result results_links', raw, flags=re.I)[1:]:
        title_match = re.search(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>', block, re.I)
        if not title_match:
            continue
        title = re.sub(r"\s+", " ", html_to_text(title_match.group(2))).strip()
        url = normalize_duck_url(title_match.group(1))
        if not title or not url:
            continue
        snippet_match = re.search(r'<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)</a>', block, re.I)
        host_match = re.search(r'<a[^>]+class="result__url"[^>]*>([\s\S]*?)</a>', block, re.I)
        results.append(
            {
                "title": title,
                "url": url,
                "snippet": re.sub(r"\s+", " ", html_to_text(snippet_match.group(1))).strip() if snippet_match else "",
                "hostname": re.sub(r"\s+", " ", html_to_text(host_match.group(1))).strip() if host_match else "",
            }
        )
        if len(results) >= max_results:
            break
    return results


def search_bing(query: str, max_results: int, language: str | None, time_range: str | None) -> dict[str, Any]:
    normalized_language = (language or "zh-CN").strip()
    if normalized_language.lower() in {"cn-zh", "zh-cn", "zh-hans"}:
        normalized_language = "zh-Hans"
    params = {"q": query, "count": str(max_results), "setlang": normalized_language, "cc": "CN"}
    freshness = bing_freshness_filter(time_range)
    if freshness:
        params["filters"] = freshness
    url = f"https://cn.bing.com/search?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "accept": "text/html,application/xhtml+xml",
            "accept-language": normalized_language,
            "user-agent": "Mozilla/5.0 MonAgent/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=search_timeout_seconds()) as response:
        raw = response.read().decode("utf-8", errors="replace")
    return {"provider": "bing", "endpoint": url, "results": parse_bing_results(raw, max_results)}


def search_duckduckgo(query: str, max_results: int, language: str | None, time_range: str | None) -> dict[str, Any]:
    params = {"q": query, "kl": language or "cn-zh", "kp": "-1"}
    if time_range:
        mapping = {"day": "d", "week": "w", "month": "m", "year": "y"}
        params["df"] = mapping.get(time_range, time_range)
    url = f"https://html.duckduckgo.com/html/?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "accept": "text/html,application/xhtml+xml",
            "accept-language": language or "zh-CN,zh;q=0.9,en;q=0.6",
            "user-agent": "Mozilla/5.0 MonAgent/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=search_timeout_seconds()) as response:
        raw = response.read().decode("utf-8", errors="replace")
    if re.search(r"anomalyDetectionBlock|detected an anomaly|captcha", raw, re.I):
        raise RuntimeError("DuckDuckGo 拒绝了本次搜索请求，可能是短时间请求过多或网络出口被限制。")
    return {"provider": "duckduckgo", "endpoint": url, "results": parse_duck_results(raw, max_results)}


def web_search(
    query: str,
    max_results: int = 5,
    language: str | None = None,
    time_range: str | None = None,
    provider: str | None = None,
) -> dict[str, Any]:
    attempts: list[dict[str, str]] = []
    searchers = {"bing": search_bing, "duckduckgo": search_duckduckgo}
    for provider_name in search_provider_order(provider):
        try:
            result = searchers[provider_name](query, max_results, language, time_range)
            if not result["results"]:
                raise RuntimeError("搜索服务未返回可解析结果")
            return {**result, "attempts": attempts}
        except Exception as error:
            attempts.append({"provider": provider_name, "error": str(error)})
    details = "; ".join(f"{SEARCH_PROVIDER_LABELS[item['provider']]}: {item['error']}" for item in attempts)
    raise RuntimeError(f"所有网页搜索入口均不可用：{details}")


def fetch_web_page(url_text: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url_text)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"只支持 http/https URL: {url_text}")
    request = urllib.request.Request(
        url_text,
        headers={"accept": "text/html, text/plain, application/json;q=0.9, */*;q=0.2", "user-agent": "MonAgent/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8", errors="replace")
        content_type = response.headers.get("content-type", "")
        final_url = response.url
    body = html_to_text(raw) if "html" in content_type else raw
    return {"url": final_url, "contentType": content_type, "title": html_title(raw) if "html" in content_type else None, "body": body}


def create_web_tools() -> list[AgentTool]:
    async def web_search_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        max_results = min(max(int(round(float(params.get("max_results") or 5))), 1), 10)
        result = await asyncio.to_thread(web_search, str(params["query"]), max_results, params.get("language"), params.get("time_range"))
        provider_label = SEARCH_PROVIDER_LABELS.get(result["provider"], result["provider"])
        lines = [f"{provider_label}搜索结果：{params['query']}"]
        for index, item in enumerate(result["results"], start=1):
            lines.append(
                "\n".join(
                    [
                        f"{index}. {item.get('title')}",
                        f"   URL: {item.get('url')}",
                        f"   摘要: {item.get('snippet')}" if item.get("snippet") else "",
                        f"   来源: {item.get('hostname')}" if item.get("hostname") else "",
                    ]
                ).strip()
            )
        return text_result(truncate("\n\n".join(lines), 20_000), result)

    async def web_fetch_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        max_chars = min(max(int(round(float(params.get("max_chars") or 28_000))), 2_000), 60_000)
        result = await asyncio.to_thread(fetch_web_page, str(params["url"]))
        body = truncate(f"{'标题: ' + result['title'] + chr(10) + chr(10) if result.get('title') else ''}{result['body']}", max_chars)
        return text_result(body, {"provider": "direct", "final_url": result["url"], "content_type": result["contentType"], "max_chars": max_chars})

    return [
        AgentTool(
            name="web_search",
            label="网页搜索",
            description="搜索实时网页信息，默认使用必应，失败时自动回退到 DuckDuckGo，不需要本地搜索服务。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词。"},
                    "max_results": {"type": "number", "description": "最多返回多少条结果，默认 5，最大 10。"},
                    "language": {"type": "string", "description": "搜索地区/语言，默认 zh-CN。"},
                    "time_range": {"type": "string", "description": "时间范围，例如 day、week、month、year。"},
                },
                "required": ["query"],
            },
            execute=web_search_execute,
        ),
        AgentTool(
            name="web_fetch",
            label="网页抓取",
            description="直接抓取网页并提取正文文本。",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要抓取的网页 URL。"},
                    "max_chars": {"type": "number", "description": "最多返回多少字符，默认 28000。"},
                },
                "required": ["url"],
            },
            execute=web_fetch_execute,
        ),
    ]
