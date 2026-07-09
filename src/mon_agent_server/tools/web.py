from __future__ import annotations

import asyncio
import html
import re
import urllib.parse
import urllib.request
from typing import Any

from mon_agent_core import AgentTool

from .result import text_result, truncate


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


def web_search(query: str, max_results: int = 5, language: str | None = None, time_range: str | None = None) -> dict[str, Any]:
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
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read().decode("utf-8", errors="replace")
    if re.search(r"anomalyDetectionBlock|detected an anomaly|captcha", raw, re.I):
        raise RuntimeError("DuckDuckGo 拒绝了本次搜索请求，可能是短时间请求过多或网络出口被限制。")
    return {"endpoint": url, "results": parse_duck_results(raw, max_results)}


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
        lines = [f"DuckDuckGo 搜索结果：{params['query']}"]
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
        return text_result(truncate("\n\n".join(lines), 20_000), {"provider": "duckduckgo", **result})

    async def web_fetch_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        max_chars = min(max(int(round(float(params.get("max_chars") or 28_000))), 2_000), 60_000)
        result = await asyncio.to_thread(fetch_web_page, str(params["url"]))
        body = truncate(f"{'标题: ' + result['title'] + chr(10) + chr(10) if result.get('title') else ''}{result['body']}", max_chars)
        return text_result(body, {"provider": "direct", "final_url": result["url"], "content_type": result["contentType"], "max_chars": max_chars})

    return [
        AgentTool(
            name="web_search",
            label="网页搜索",
            description="使用 DuckDuckGo 搜索实时网页信息，不需要本地搜索服务。",
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
