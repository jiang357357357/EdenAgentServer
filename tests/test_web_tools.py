from __future__ import annotations

import os
import unittest
from datetime import date
from unittest.mock import patch

from mon_agent_server.tools.web import (
    bing_freshness_filter,
    clear_search_cache,
    normalize_bing_url,
    parse_bing_results,
    search_provider_order,
    search_timeout_seconds,
    web_search,
)
from mon_agent_server.tools.web_fetcher import extract_html, validate_public_http_url
from mon_agent_server.tools.web_providers import (
    BraveSearchProvider,
    ExaSearchProvider,
    SearchRequest,
    SearchResponse,
    SearxngSearchProvider,
    TavilySearchProvider,
    normalize_results,
)


BING_HTML = """
<ol id="b_results">
  <li class="b_algo" data-id="SERP.1">
    <div class="b_tpcn"><cite>https://example.com › docs</cite></div>
    <h2><a href="https://example.com/docs"><strong>MonAgent</strong> 文档</a></h2>
    <div class="b_caption"><p>第一条 &amp; 可用摘要。</p></div>
  </li>
  <li class="b_algo featured" data-id="SERP.2">
    <h2><a href="https://example.org/news">MonAgent 新闻</a></h2>
    <div class="b_caption"><p>第二条摘要。</p></div>
  </li>
</ol>
"""


class BingParserTest(unittest.TestCase):
    def test_parse_bing_results_extracts_and_limits_items(self) -> None:
        results = parse_bing_results(BING_HTML, 1)

        self.assertEqual(
            results,
            [
                {
                    "title": "MonAgent 文档",
                    "url": "https://example.com/docs",
                    "snippet": "第一条 & 可用摘要。",
                    "hostname": "https://example.com › docs",
                }
            ],
        )

    def test_normalize_bing_url_decodes_redirect_target(self) -> None:
        self.assertEqual(
            normalize_bing_url("https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9kb2Nz"),
            "https://example.com/docs",
        )


class WebSearchProviderTest(unittest.TestCase):
    def setUp(self) -> None:
        clear_search_cache()

    def test_bing_is_default_provider(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(search_provider_order(), ["bing", "duckduckgo"])

    def test_auto_provider_prefers_configured_structured_api(self) -> None:
        with patch.dict(os.environ, {"BRAVE_SEARCH_API_KEY": "secret", "EXA_API_KEY": "secret"}, clear=True):
            self.assertEqual(search_provider_order(), ["brave", "exa", "bing", "duckduckgo"])

    def test_configured_duckduckgo_is_tried_first(self) -> None:
        with patch.dict(os.environ, {"MON_AGENT_SEARCH_PROVIDER": "ddg"}, clear=True):
            self.assertEqual(search_provider_order(), ["duckduckgo", "bing"])

    def test_timeout_is_configurable_and_bounded(self) -> None:
        with patch.dict(os.environ, {"MON_AGENT_SEARCH_TIMEOUT_MS": "250"}, clear=True):
            self.assertEqual(search_timeout_seconds(), 1.0)
        with patch.dict(os.environ, {"MON_AGENT_SEARCH_TIMEOUT_MS": "90000"}, clear=True):
            self.assertEqual(search_timeout_seconds(), 60.0)
        with patch.dict(os.environ, {"MON_AGENT_SEARCH_TIMEOUT_MS": "invalid"}, clear=True):
            self.assertEqual(search_timeout_seconds(), 10.0)

    def test_bing_year_filter_covers_previous_365_days(self) -> None:
        self.assertEqual(
            bing_freshness_filter("year", date(2026, 7, 19)),
            'ex1:"ez5_20288_20653"',
        )

    def test_web_search_uses_bing_without_calling_fallback(self) -> None:
        bing = FakeProvider("bing", results=[{"title": "结果", "url": "https://example.com"}])
        duck = FakeProvider("duckduckgo", error=AssertionError("不应调用备用入口"))
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "0"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            result = web_search("测试")

        self.assertEqual(bing.calls, 1)
        self.assertEqual(duck.calls, 0)
        self.assertEqual(result["provider"], "bing")
        self.assertEqual(result["attempts"], [])
        self.assertEqual(result["results"][0]["id"], "source_1")

    def test_web_search_uses_short_lived_cache(self) -> None:
        bing = FakeProvider("bing", results=[{"title": "结果", "url": "https://example.com"}])
        duck = FakeProvider("duckduckgo", error=AssertionError("不应调用备用入口"))
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "120"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            first = web_search("测试")
            second = web_search("测试")

        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(bing.calls, 1)

    def test_web_search_falls_back_to_duckduckgo(self) -> None:
        bing = FakeProvider("bing", error=OSError("bing unavailable"))
        duck = FakeProvider("duckduckgo", results=[{"title": "备用结果", "url": "https://example.org"}])
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "0"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            result = web_search("测试")

        self.assertEqual(duck.calls, 1)
        self.assertEqual(result["provider"], "duckduckgo")
        self.assertEqual(result["attempts"][0]["provider"], "bing")
        self.assertEqual(result["attempts"][0]["error"], "bing unavailable")

    def test_web_search_reports_both_provider_failures(self) -> None:
        bing = FakeProvider("bing", error=OSError("bing unavailable"))
        duck = FakeProvider("duckduckgo", error=OSError("duck unavailable"))
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "0"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            with self.assertRaisesRegex(RuntimeError, "必应: bing unavailable; DuckDuckGo: duck unavailable"):
                web_search("测试")

    def test_search_result_schema_deduplicates_urls(self) -> None:
        results = normalize_results(
            "exa",
            [
                {"title": "A", "url": "https://example.com/a#part", "content": "摘要", "score": 0.9},
                {"title": "A duplicate", "url": "https://example.com/a"},
                {"title": "B", "url": "https://example.org/b", "publishedDate": "2026-07-22"},
            ],
            5,
        )

        self.assertEqual([item["id"] for item in results], ["source_1", "source_2"])
        self.assertEqual([item["source_id"] for item in results], ["source_1", "source_2"])
        self.assertEqual(results[0]["url"], "https://example.com/a")
        self.assertEqual(results[0]["hostname"], "example.com")
        self.assertEqual(results[0]["provider"], "exa")
        self.assertEqual(results[1]["published_at"], "2026-07-22")


class FakeProvider:
    def __init__(self, name: str, *, results: list[dict[str, object]] | None = None, error: Exception | None = None) -> None:
        self.name = name
        self.results = results or []
        self.error = error
        self.calls = 0

    def configured(self) -> bool:
        return True

    def search(self, request: object) -> SearchResponse:
        self.calls += 1
        if self.error:
            raise self.error
        normalized = normalize_results(self.name, self.results, 10)
        return SearchResponse(provider=self.name, endpoint=f"https://{self.name}.example/search", results=normalized)


class StructuredProviderAdapterTest(unittest.TestCase):
    def test_brave_maps_web_results_to_unified_schema(self) -> None:
        payload = {"web": {"results": [{"title": "文档", "url": "https://example.com/docs", "description": "摘要"}]}}
        with (
            patch.dict(os.environ, {"BRAVE_SEARCH_API_KEY": "key"}, clear=True),
            patch("mon_agent_server.tools.web_providers._json_request", return_value=payload) as request,
        ):
            result = BraveSearchProvider().search(SearchRequest("MonAgent", domains=("example.com",)))

        self.assertEqual(result.results[0]["source_id"], "source_1")
        self.assertEqual(result.results[0]["snippet"], "摘要")
        self.assertIn("site%3Aexample.com", request.call_args.args[0])

    def test_exa_passes_domain_filter_and_maps_highlights(self) -> None:
        payload = {
            "results": [
                {
                    "title": "文档",
                    "url": "https://example.com/docs",
                    "highlights": ["第一段", "第二段"],
                    "score": 0.8,
                }
            ]
        }
        with (
            patch.dict(os.environ, {"EXA_API_KEY": "key"}, clear=True),
            patch("mon_agent_server.tools.web_providers._json_request", return_value=payload) as request,
        ):
            result = ExaSearchProvider().search(SearchRequest("MonAgent", domains=("example.com",)))

        self.assertEqual(result.results[0]["snippet"], "第一段 第二段")
        self.assertEqual(result.results[0]["score"], 0.8)
        self.assertEqual(request.call_args.kwargs["payload"]["includeDomains"], ["example.com"])

    def test_tavily_and_searxng_return_the_same_schema(self) -> None:
        payload = {"results": [{"title": "结果", "url": "https://example.org/a", "content": "内容", "score": 0.7}]}
        with (
            patch.dict(os.environ, {"TAVILY_API_KEY": "key"}, clear=True),
            patch("mon_agent_server.tools.web_providers._json_request", return_value=payload),
        ):
            tavily = TavilySearchProvider().search(SearchRequest("测试"))
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARXNG_URL": "https://search.example"}, clear=True),
            patch("mon_agent_server.tools.web_providers._json_request", return_value=payload),
        ):
            searxng = SearxngSearchProvider().search(SearchRequest("测试"))

        for response in (tavily, searxng):
            self.assertEqual(response.results[0]["source_id"], "source_1")
            self.assertEqual(response.results[0]["hostname"], "example.org")


class WebFetchSecurityTest(unittest.TestCase):
    def test_rejects_localhost_before_dns_lookup(self) -> None:
        with self.assertRaisesRegex(ValueError, "内部网络"):
            validate_public_http_url("http://localhost:8080/private")

    def test_rejects_private_dns_result(self) -> None:
        with patch("mon_agent_server.tools.web_fetcher.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("192.168.1.8", 80))]):
            with self.assertRaisesRegex(ValueError, "私网"):
                validate_public_http_url("http://example.test/private")

    def test_accepts_public_dns_result(self) -> None:
        with patch("mon_agent_server.tools.web_fetcher.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            parsed = validate_public_http_url("https://example.com/docs")
        self.assertEqual(parsed.hostname, "example.com")

    def test_extract_html_removes_scripts_and_keeps_structure(self) -> None:
        title, body = extract_html(
            "<html><head><title>示例 文档</title><style>bad</style></head>"
            "<body><h1>标题</h1><script>ignore()</script><p>第一段。</p><ul><li>项目一</li></ul></body></html>"
        )
        self.assertEqual(title, "示例 文档")
        self.assertNotIn("ignore", body)
        self.assertNotIn("bad", body)
        self.assertIn("标题\n\n第一段。", body)
        self.assertIn("- 项目一", body)


if __name__ == "__main__":
    unittest.main()
