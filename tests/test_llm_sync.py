from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from mon_agent_server.llm.sync import call_openai_compatible
from mon_agent_server.llm.messages import to_openai_messages, to_responses_input
from mon_agent_server.agent_api import AgentTool, text_tool_result


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def read(self) -> bytes:
        return b'{"choices":[{"message":{"content":"ok"}}]}'


class SyncModelRequestTests(unittest.TestCase):
    def test_structured_tool_output_is_forwarded_with_display_text(self) -> None:
        context = {"messages": [{
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "query_openttd",
            "content": [{"type": "text", "text": "查询完成"}],
            "structuredContent": {"towns": [{"name": "A"}]},
        }]}
        chat = to_openai_messages(context)
        responses = to_responses_input(context)
        self.assertIn("查询完成", chat[0]["content"])
        self.assertIn('"towns"', chat[0]["content"])
        self.assertIn('"towns"', responses[0]["output"])

    def test_only_direct_tools_are_serialized(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(request, timeout):
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse()

        tools = [
            AgentTool("read", "read", "read", execute=lambda *_: text_tool_result("ok")),
            AgentTool(
                "query_openttd", "OpenTTD", "OpenTTD",
                execute=lambda *_: text_tool_result("ok"), exposure="deferred",
                output_schema={"type": "object", "properties": {}},
            ),
            AgentTool(
                "heartbeat", "heartbeat", "heartbeat",
                execute=lambda *_: text_tool_result("ok"), exposure="hidden",
            ),
        ]
        model = {"id": "test", "provider": "openai", "baseUrl": "https://example.test/v1"}
        with patch("mon_agent_server.llm.sync.urllib.request.urlopen", fake_urlopen):
            call_openai_compatible(model, {"messages": [], "tools": tools}, {"apiKey": "sk-test"})

        body = captured["body"]
        self.assertEqual([item["function"]["name"] for item in body["tools"]], ["read"])

    def test_thinking_disabled_is_forwarded_to_provider(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(request, timeout):
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse()

        model = {
            "id": "mimo-v2.5",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {
            "messages": [{"role": "user", "content": [{"type": "text", "text": "route"}]}],
            "tools": [],
        }
        with patch("mon_agent_server.llm.sync.urllib.request.urlopen", fake_urlopen):
            call_openai_compatible(
                model,
                context,
                {
                    "apiKey": "sk-test",
                    "maxTokens": 1200,
                    "thinking": {"type": "disabled"},
                },
            )

        body = captured["body"]
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(body["max_tokens"], 1200)
        self.assertNotIn("reasoning_effort", body)

    def test_invalid_thinking_option_is_rejected_before_request(self) -> None:
        model = {"id": "test", "provider": "openai", "baseUrl": "https://example.test/v1"}
        context = {"messages": [], "tools": []}
        with self.assertRaisesRegex(ValueError, "thinking"):
            call_openai_compatible(
                model,
                context,
                {"apiKey": "sk-test", "thinking": {"type": "sometimes"}},
            )


if __name__ == "__main__":
    unittest.main()
