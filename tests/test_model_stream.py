import json
import unittest
from unittest.mock import patch

from mon_agent_server.model_stream import _usage_from_openai, call_openai_compatible, stream_openai_compatible, to_openai_messages


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def read(self):
        return json.dumps(
            {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }
        ).encode()


class FakeStreamResponse:
    def __init__(self, lines):
        self.lines = lines

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def __iter__(self):
        return iter(self.lines)


class ModelStreamTest(unittest.IsolatedAsyncioTestCase):
    def test_usage_counts_cached_prompt_tokens_as_input(self):
        usage = _usage_from_openai(
            {
                "prompt_tokens": 1309,
                "completion_tokens": 723,
                "prompt_tokens_details": {"cached_tokens": 5143},
            }
        )

        self.assertEqual(usage["input"], 6452)
        self.assertEqual(usage["output"], 723)
        self.assertEqual(usage["cacheRead"], 5143)
        self.assertEqual(usage["cacheMiss"], 1309)
        self.assertEqual(usage["totalTokens"], 7175)

    def test_openai_compatible_request_sets_user_agent(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse()

        model = {
            "id": "minimax-m2.7",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {
            "messages": [{"role": "user", "content": [{"type": "text", "text": "ping"}]}],
            "tools": [],
        }

        with patch("urllib.request.urlopen", fake_urlopen):
            response = call_openai_compatible(model, context, {"apiKey": "sk-test"})

        self.assertEqual(response["choices"][0]["message"]["content"], "ok")
        self.assertEqual(captured["request"].full_url, "https://opencode.ai/zen/go/v1/chat/completions")
        self.assertEqual(captured["request"].get_header("User-agent"), "MonAgent/0.1")

    def test_openai_messages_include_compaction_summary(self):
        messages = to_openai_messages(
            {
                "messages": [
                    {"role": "compactionSummary", "summary": "用户正在调试上下文压缩。"},
                    {"role": "user", "content": [{"type": "text", "text": "继续"}]},
                ]
            }
        )

        self.assertEqual(messages[0]["role"], "user")
        self.assertIn("<summary>", messages[0]["content"])
        self.assertIn("用户正在调试上下文压缩。", messages[0]["content"])
        self.assertEqual(messages[1], {"role": "user", "content": "继续"})

    async def test_openai_compatible_streams_text_deltas(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            captured["body"] = json.loads(request.data.decode())
            return FakeStreamResponse(
                [
                    b'data: {"choices":[{"delta":{"content":"he"},"finish_reason":null}]}\n\n',
                    b'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
                    b"data: [DONE]\n\n",
                ]
            )

        model = {
            "id": "minimax-m2.7",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {
            "messages": [{"role": "user", "content": [{"type": "text", "text": "ping"}]}],
            "tools": [],
        }

        with patch("urllib.request.urlopen", fake_urlopen):
            stream = await stream_openai_compatible(model, context, {"apiKey": "sk-test"})
            events = [event async for event in stream]

        self.assertTrue(captured["body"]["stream"])
        self.assertEqual(captured["request"].get_header("Accept"), "text/event-stream")
        self.assertEqual([event["type"] for event in events], ["start", "text_start", "text_delta", "text_delta", "text_end", "done"])
        self.assertEqual(events[-1]["message"]["content"], [{"type": "text", "text": "hello"}])
        self.assertEqual(events[-1]["message"]["usage"]["totalTokens"], 5)

    async def test_openai_compatible_streams_tool_calls(self):
        def fake_urlopen(_request, timeout):
            return FakeStreamResponse(
                [
                    b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n',
                    b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
                    b"data: [DONE]\n\n",
                ]
            )

        model = {
            "id": "minimax-m2.7",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {
            "messages": [{"role": "user", "content": [{"type": "text", "text": "read"}]}],
            "tools": [],
        }

        with patch("urllib.request.urlopen", fake_urlopen):
            stream = await stream_openai_compatible(model, context, {"apiKey": "sk-test"})
            events = [event async for event in stream]

        self.assertEqual([event["type"] for event in events], ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"])
        self.assertEqual(events[-1]["message"]["stopReason"], "tool_calls")
        self.assertEqual(events[-1]["message"]["content"][0]["name"], "read")
        self.assertEqual(events[-1]["message"]["content"][0]["arguments"], {"path": "a.txt"})


if __name__ == "__main__":
    unittest.main()
