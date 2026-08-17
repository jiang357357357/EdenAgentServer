from __future__ import annotations

import os
import asyncio
import unittest
from datetime import date
from unittest.mock import patch

from mon_agent_server.tools.web import (
    _merge_search_results,
    _run_web_worker,
    bing_freshness_filter,
    clear_search_cache,
    clear_web_resources,
    create_web_tools,
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
    DuckDuckGoSearchProvider,
    ExaMcpSearchProvider,
    ParallelMcpSearchProvider,
    html_to_text,
    parse_duck_lite_results,
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

    def test_inline_highlight_tags_do_not_split_words(self) -> None:
        self.assertEqual(html_to_text("普雷<strong>纳帕</strong>特斯"), "普雷纳帕特斯")

    def test_parse_duck_lite_results(self) -> None:
        raw = """
        <a class='result-link' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs'>示例<strong>文档</strong></a>
        <td class='result-snippet'>正文摘要</td>
        """
        self.assertEqual(
            parse_duck_lite_results(raw, 5),
            [{"title": "示例文档", "url": "https://example.com/docs", "snippet": "正文摘要", "hostname": "example.com"}],
        )


class WebSearchProviderTest(unittest.TestCase):
    def setUp(self) -> None:
        clear_search_cache()

    def test_remote_mcp_is_default_before_html_providers(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(search_provider_order(), ["parallel_mcp", "exa_mcp", "bing", "duckduckgo"])

    def test_auto_provider_prefers_configured_structured_api(self) -> None:
        with patch.dict(os.environ, {"BRAVE_SEARCH_API_KEY": "secret", "EXA_API_KEY": "secret"}, clear=True):
            self.assertEqual(search_provider_order(), ["parallel_mcp", "exa_mcp", "brave", "exa", "bing", "duckduckgo"])

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
        bing = FakeProvider("bing", results=[{"title": "测试结果", "url": "https://example.com"}])
        duck = FakeProvider("duckduckgo", error=AssertionError("不应调用备用入口"))
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "0", "MON_AGENT_SEARCH_PROVIDER": "bing,duckduckgo"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            result = web_search("测试")

        self.assertEqual(bing.calls, 1)
        self.assertEqual(duck.calls, 0)
        self.assertEqual(result["provider"], "bing")
        self.assertEqual(result["attempts"], [])
        self.assertEqual(result["results"][0]["id"], "source_1")

    def test_web_search_uses_short_lived_cache(self) -> None:
        bing = FakeProvider("bing", results=[{"title": "测试结果", "url": "https://example.com"}])
        duck = FakeProvider("duckduckgo", error=AssertionError("不应调用备用入口"))
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "120", "MON_AGENT_SEARCH_PROVIDER": "bing,duckduckgo"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            first = web_search("测试")
            second = web_search("测试")

        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(bing.calls, 1)

    def test_web_search_falls_back_to_duckduckgo(self) -> None:
        bing = FakeProvider("bing", error=OSError("bing unavailable"))
        duck = FakeProvider("duckduckgo", results=[{"title": "测试备用结果", "url": "https://example.org"}])
        with (
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "0", "MON_AGENT_SEARCH_PROVIDER": "bing,duckduckgo"}, clear=True),
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
            patch.dict(os.environ, {"MON_AGENT_SEARCH_CACHE_TTL_SECONDS": "0", "MON_AGENT_SEARCH_PROVIDER": "bing,duckduckgo"}, clear=True),
            patch("mon_agent_server.tools.web.create_search_providers", return_value={"bing": bing, "duckduckgo": duck}),
        ):
            with self.assertRaisesRegex(RuntimeError, "必应: bing unavailable; DuckDuckGo: duck unavailable"):
                web_search("测试")

    def test_multiple_searches_merge_and_renumber_sources(self) -> None:
        merged = _merge_search_results(
            [
                {"provider": "bing", "query": "普雷纳帕特斯", "results": [{"source_id": "source_1", "title": "中文资料", "url": "https://example.com/zh"}]},
                {"provider": "bing", "query": "プレナパテス", "results": [{"source_id": "source_1", "title": "日本語資料", "url": "https://example.jp/ja"}]},
            ],
            10,
        )

        self.assertEqual(merged["queries"], ["普雷纳帕特斯", "プレナパテス"])
        self.assertEqual([item["source_id"] for item in merged["results"]], ["source_1", "source_2"])

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

    def test_search_results_deduplicate_similar_titles_and_limit_same_host(self) -> None:
        results = normalize_results(
            "bing",
            [
                {"title": "普雷纳帕特斯 - 萌娘百科", "url": "https://mirror-a.example/character"},
                {"title": "普雷纳帕特斯—萌娘百科", "url": "https://mirror-b.example/character"},
                {"title": "独立资料一", "url": "https://wiki.example/a"},
                {"title": "独立资料二", "url": "https://wiki.example/b"},
                {"title": "独立资料三", "url": "https://wiki.example/c"},
            ],
            10,
            "普雷纳帕特斯",
        )

        self.assertEqual([item["title"] for item in results], ["普雷纳帕特斯 - 萌娘百科", "独立资料一", "独立资料二"])

    def test_exact_title_match_is_ranked_before_loose_results(self) -> None:
        results = normalize_results(
            "bing",
            [
                {"title": "相关角色资料", "url": "https://example.org/related"},
                {"title": "普雷纳帕特斯角色资料", "url": "https://example.com/exact"},
            ],
            10,
            "普雷纳帕特斯",
        )

        self.assertEqual(results[0]["url"], "https://example.com/exact")

    def test_duckduckgo_http_202_is_reported_as_anti_automation(self) -> None:
        class Response:
            status = 202

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"<html><title>DuckDuckGo</title></html>"

        DuckDuckGoSearchProvider.clear_cooldown()
        with (
            patch.dict(os.environ, {"MON_AGENT_DUCKDUCKGO_COOLDOWN_SECONDS": "900"}, clear=True),
            patch("mon_agent_server.tools.web_providers.urllib.request.urlopen", return_value=Response()),
        ):
            with self.assertRaisesRegex(RuntimeError, "HTML/Lite 均不可用.*HTTP 202"):
                DuckDuckGoSearchProvider().search(SearchRequest("测试"))
            with self.assertRaisesRegex(RuntimeError, "冷却期"):
                DuckDuckGoSearchProvider().search(SearchRequest("测试"))
        DuckDuckGoSearchProvider.clear_cooldown()


class WebToolTimeoutTest(unittest.IsolatedAsyncioTestCase):
    async def test_web_search_has_total_async_timeout(self) -> None:
        async def hanging_worker(*_args, **_kwargs):
            await asyncio.Event().wait()

        tool = next(item for item in create_web_tools() if item.name == "web")
        with (
            patch("mon_agent_server.tools.web._run_web_worker", new=hanging_worker),
            patch("mon_agent_server.tools.web._total_tool_timeout_seconds", return_value=0.01),
        ):
            with self.assertRaisesRegex(RuntimeError, "网页搜索总超时"):
                await tool.execute("call-timeout", {"action": "search", "query": "测试"})

    async def test_batch_search_keeps_successful_queries_when_one_fails(self) -> None:
        tool = next(item for item in create_web_tools() if item.name == "web")

        async def fake_worker(_action, params):
            query = params["query"]
            if query == "失败查询":
                raise RuntimeError("没有结果")
            return {
                "provider": "bing",
                "query": query,
                "results": [{"title": f"{query}结果", "url": "https://example.com/result", "provider": "bing"}],
                "attempts": [],
                "cached": False,
                "elapsed_ms": 10,
            }

        with patch("mon_agent_server.tools.web._run_web_worker", side_effect=fake_worker):
            result = await tool.execute("call-batch", {"action": "search", "query": "成功查询", "queries": ["失败查询"]})

        self.assertIn("成功查询结果", result["content"][0]["text"])
        self.assertEqual(result["details"]["query_errors"], {"失败查询": "没有结果"})

    async def test_search_open_and_find_share_session_scoped_refs(self) -> None:
        from mon_agent_server.tools.context import MonToolContext

        clear_web_resources()
        tool = create_web_tools(MonToolContext(session_id="session-a"))[0]
        async def fake_worker(action, _params):
            if action == "open":
                return {
                    "url": "https://example.com/docs", "title": "文档", "body": "MonAgent 支持统一网页工具。",
                    "contentType": "text/html", "bytes": 30, "truncated": False, "charset": "utf-8",
                }
            return {
                "provider": "bing", "query": "MonAgent", "results": [
                    {"title": "文档", "url": "https://example.com/docs", "provider": "bing"}
                ], "attempts": [], "cached": False, "elapsed_ms": 1,
            }

        with patch("mon_agent_server.tools.web._run_web_worker", side_effect=fake_worker):
            searched = await tool.execute("search", {"action": "search", "query": "MonAgent"})
            opened = await tool.execute("open", {"action": "open", "ref_id": "search_1"})
        self.assertEqual(searched["details"]["results"][0]["ref_id"], "search_1")
        self.assertEqual(opened["details"]["ref_id"], "page_1")

        found = await tool.execute("find", {"action": "find", "ref_id": "page_1", "pattern": "统一网页"})
        self.assertEqual(len(found["details"]["matches"]), 1)

    async def test_cancelling_web_worker_terminates_its_process(self) -> None:
        communicate_started = asyncio.Event()

        class Process:
            returncode = None
            terminated = False

            async def communicate(self, _payload):
                communicate_started.set()
                await asyncio.Event().wait()

            def terminate(self):
                self.terminated = True
                self.returncode = -15

            async def wait(self):
                return self.returncode

            def kill(self):
                self.returncode = -9

        process = Process()
        with patch("mon_agent_server.tools.web.asyncio.create_subprocess_exec", return_value=process):
            task = asyncio.create_task(_run_web_worker("search", {"query": "test"}))
            await asyncio.wait_for(communicate_started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertTrue(process.terminated)


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
    def test_parallel_mcp_uses_anonymous_endpoint_and_maps_results(self) -> None:
        tool_text = '{"results":[{"title":"条目","url":"https://example.com/a","excerpts":["摘要"]}]}'
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("mon_agent_server.tools.web_providers._mcp_call", return_value=tool_text) as call,
        ):
            result = ParallelMcpSearchProvider().search(SearchRequest("测试"))
        self.assertEqual(result.results[0]["snippet"], "摘要")
        self.assertIsNone(call.call_args.args[3])

    def test_parallel_mcp_submits_only_parallel_key(self) -> None:
        with (
            patch.dict(os.environ, {"PARALLEL_API_KEY": "parallel-secret", "OPENCODE_API_KEY": "model-secret"}, clear=True),
            patch("mon_agent_server.tools.web_providers._mcp_call", return_value='{"results":[]}') as call,
        ):
            ParallelMcpSearchProvider().search(SearchRequest("测试"))
        self.assertEqual(call.call_args.args[3], {"authorization": "Bearer parallel-secret"})

    def test_exa_mcp_maps_sse_tool_text_and_uses_only_exa_key(self) -> None:
        tool_text = "Title: 示例条目\nURL: https://example.org/doc\nPublished: 2026-08-04\nAuthor: N/A\nHighlights:\n正文摘要"
        with (
            patch.dict(os.environ, {"EXA_API_KEY": "exa-secret", "OPENCODE_API_KEY": "model-secret"}, clear=True),
            patch("mon_agent_server.tools.web_providers._mcp_call", return_value=tool_text) as call,
        ):
            result = ExaMcpSearchProvider().search(SearchRequest("示例"))
        self.assertEqual(result.results[0]["title"], "示例条目")
        self.assertEqual(result.results[0]["snippet"], "正文摘要")
        self.assertEqual(call.call_args.args[3], {"x-api-key": "exa-secret"})

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
