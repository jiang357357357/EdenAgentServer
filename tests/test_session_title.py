from __future__ import annotations

import unittest
from types import SimpleNamespace

from mon_agent_server.session_title import fallback_session_title, generate_session_title, normalize_generated_title


class SessionTitleTests(unittest.TestCase):
    def test_fallback_collapses_whitespace_and_limits_length(self):
        title = fallback_session_title("  第一行\n第二行  " + "长" * 60)
        self.assertNotIn("\n", title)
        self.assertLessEqual(len(title), 50)
        self.assertTrue(title.endswith("..."))

    def test_generated_title_removes_markdown_and_quotes(self):
        self.assertEqual(normalize_generated_title('**"修复会话标题"**'), "修复会话标题")
        self.assertEqual(normalize_generated_title("`会话标题生成`"), "会话标题生成")

    def test_missing_model_credentials_does_not_fall_back_to_first_message(self):
        result = __import__("asyncio").run(
            generate_session_title(SimpleNamespace(api_key=""), "你好", "你好，有什么可以帮你？")
        )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
