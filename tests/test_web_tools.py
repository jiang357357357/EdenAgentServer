from __future__ import annotations

import os
import unittest
from datetime import date
from unittest.mock import patch

from mon_agent_server.tools.web import (
    bing_freshness_filter,
    normalize_bing_url,
    parse_bing_results,
    search_provider_order,
    search_timeout_seconds,
    web_search,
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
    def test_bing_is_default_provider(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(search_provider_order(), ["bing", "duckduckgo"])

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
        bing_result = {"provider": "bing", "endpoint": "https://cn.bing.com/search", "results": [{"title": "结果"}]}
        with (
            patch("mon_agent_server.tools.web.search_bing", return_value=bing_result) as bing,
            patch("mon_agent_server.tools.web.search_duckduckgo") as duck,
        ):
            result = web_search("测试")

        bing.assert_called_once()
        duck.assert_not_called()
        self.assertEqual(result["provider"], "bing")
        self.assertEqual(result["attempts"], [])

    def test_web_search_falls_back_to_duckduckgo(self) -> None:
        duck_result = {
            "provider": "duckduckgo",
            "endpoint": "https://html.duckduckgo.com/html/",
            "results": [{"title": "备用结果"}],
        }
        with (
            patch("mon_agent_server.tools.web.search_bing", side_effect=OSError("bing unavailable")),
            patch("mon_agent_server.tools.web.search_duckduckgo", return_value=duck_result) as duck,
        ):
            result = web_search("测试")

        duck.assert_called_once()
        self.assertEqual(result["provider"], "duckduckgo")
        self.assertEqual(result["attempts"], [{"provider": "bing", "error": "bing unavailable"}])

    def test_web_search_reports_both_provider_failures(self) -> None:
        with (
            patch("mon_agent_server.tools.web.search_bing", side_effect=OSError("bing unavailable")),
            patch("mon_agent_server.tools.web.search_duckduckgo", side_effect=OSError("duck unavailable")),
        ):
            with self.assertRaisesRegex(RuntimeError, "必应: bing unavailable; DuckDuckGo: duck unavailable"):
                web_search("测试")


if __name__ == "__main__":
    unittest.main()
