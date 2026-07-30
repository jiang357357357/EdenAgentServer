import io
import json
import ssl
import unittest
import urllib.error
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


class InterruptedStreamResponse(FakeStreamResponse):
    def __iter__(self):
        yield from self.lines
        raise ssl.SSLEOFError(8, "unexpected eof while reading")


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

    def test_openai_messages_skip_failed_and_empty_assistant_items(self):
        messages = to_openai_messages(
            {
                "messages": [
                    {"role": "user", "content": "第一次请求"},
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": ""}],
                        "stopReason": "error",
                        "errorMessage": "SSL EOF",
                    },
                    {"role": "assistant", "content": [{"type": "text", "text": ""}]},
                    {"role": "user", "content": "重新请求"},
                ]
            }
        )

        self.assertEqual(messages, [{"role": "user", "content": "第一次请求"}, {"role": "user", "content": "重新请求"}])

    def test_openai_messages_label_only_other_assistants(self):
        messages = to_openai_messages(
            {
                "activeSpeaker": {"assistantID": 2, "assistantName": "助手 B"},
                "messages": [
                    {
                        "role": "assistant",
                        "contextSpeaker": {"assistantID": 1, "assistantName": "助手 A"},
                        "content": [{"type": "text", "text": "这是 A 的历史回复。"}],
                    },
                    {
                        "role": "assistant",
                        "contextSpeaker": {"assistantID": 2, "assistantName": "助手 B"},
                        "content": [{"type": "text", "text": "这是 B 的历史回复。"}],
                    },
                ],
            }
        )

        self.assertEqual(messages[0]["content"], "[助手 A] 这是 A 的历史回复。")
        self.assertEqual(messages[1]["content"], "这是 B 的历史回复。")

    def test_openai_messages_label_other_assistant_tool_call_without_extra_prompt(self):
        messages = to_openai_messages(
            {
                "activeSpeaker": {"assistantID": 2, "assistantName": "助手 B"},
                "messages": [
                    {
                        "role": "assistant",
                        "contextSpeaker": {"assistantID": 1, "assistantName": "助手 A"},
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "switch-1",
                                "name": "switch_session_assistant",
                                "arguments": {"assistant_id": 2},
                            }
                        ],
                    }
                ],
            }
        )

        self.assertEqual(messages[0]["content"], "[助手 A]")
        self.assertEqual(messages[0]["tool_calls"][0]["function"]["name"], "switch_session_assistant")

    def test_tool_result_image_is_forwarded_as_multimodal_context(self):
        messages = to_openai_messages(
            {
                "messages": [
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "tool-1",
                                "name": "analyze_screen",
                                "arguments": {"question": "屏幕上是什么？"},
                            }
                        ],
                    },
                    {
                        "role": "toolResult",
                        "toolCallId": "tool-1",
                        "toolName": "analyze_screen",
                        "content": [
                            {"type": "text", "text": "请根据当前屏幕截图回答。"},
                            {"type": "image", "mimeType": "image/png", "data": "YQ=="},
                        ],
                    },
                ]
            }
        )

        self.assertEqual(messages[1]["role"], "tool")
        self.assertEqual(messages[1]["tool_call_id"], "tool-1")
        self.assertEqual(messages[2]["role"], "user")
        self.assertIn("不要", messages[2]["content"][0]["text"])
        self.assertEqual(messages[2]["content"][1]["type"], "image_url")
        self.assertEqual(messages[2]["content"][1]["image_url"]["url"], "data:image/png;base64,YQ==")

    def test_tool_continuation_replays_reasoning_in_original_provider_field(self):
        messages = to_openai_messages(
            {
                "messages": [
                    {
                        "role": "assistant",
                        "provider": "opencode-go",
                        "content": [
                            {
                                "type": "thinking",
                                "thinking": "I should inspect the screen.",
                                "thinkingSignature": "reasoning_content",
                            },
                            {
                                "type": "toolCall",
                                "id": "call_1",
                                "name": "analyze_screen",
                                "arguments": {"question": "当前游戏是什么？"},
                            },
                        ],
                    },
                    {
                        "role": "toolResult",
                        "toolCallId": "call_1",
                        "toolName": "analyze_screen",
                        "content": [{"type": "text", "text": "Riddle Joker"}],
                    },
                ]
            }
        )

        self.assertEqual(messages[0]["reasoning_content"], "I should inspect the screen.")
        self.assertIsNone(messages[0]["content"])
        self.assertEqual(messages[0]["tool_calls"][0]["id"], "call_1")
        self.assertEqual(messages[1]["tool_call_id"], "call_1")

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

    async def test_openai_compatible_retries_ssl_eof_before_stream_starts(self):
        attempts = 0

        def fake_urlopen(_request, timeout):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise urllib.error.URLError(ssl.SSLEOFError(8, "unexpected eof while reading"))
            return FakeStreamResponse(
                [
                    b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
                    b"data: [DONE]\n\n",
                ]
            )

        model = {
            "id": "mimo-v2.5",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {"messages": [{"role": "user", "content": "ping"}], "tools": []}

        with patch("urllib.request.urlopen", fake_urlopen), patch("mon_agent_server.llm.openai_compatible.time.sleep"):
            stream = await stream_openai_compatible(model, context, {"apiKey": "sk-test"})
            events = [event async for event in stream]

        self.assertEqual(attempts, 2)
        retry = next(event for event in events if event["type"] == "provider_retry")
        self.assertEqual((retry["attempt"], retry["maxAttempts"]), (2, 3))
        self.assertEqual(events[-1]["message"]["content"][0]["text"], "ok")

    async def test_openai_compatible_retries_upstream_500(self):
        attempts = 0

        def fake_urlopen(_request, timeout):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise urllib.error.HTTPError(
                    "https://opencode.ai/zen/go/v1/chat/completions",
                    500,
                    "Internal Server Error",
                    None,
                    io.BytesIO(b'{"error":{"message":"Internal server error"}}'),
                )
            return FakeStreamResponse(
                [
                    b'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\n',
                    b"data: [DONE]\n\n",
                ]
            )

        model = {
            "id": "mimo-v2.5",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {"messages": [{"role": "user", "content": "ping"}], "tools": []}

        with patch("urllib.request.urlopen", fake_urlopen), patch("mon_agent_server.llm.openai_compatible.time.sleep"):
            stream = await stream_openai_compatible(model, context, {"apiKey": "sk-test"})
            events = [event async for event in stream]

        self.assertEqual(attempts, 2)
        self.assertEqual([event["type"] for event in events].count("provider_retry"), 1)
        self.assertEqual(events[-1]["message"]["content"][0]["text"], "recovered")

    async def test_openai_compatible_does_not_replay_after_stream_content(self):
        attempts = 0

        def fake_urlopen(_request, timeout):
            nonlocal attempts
            attempts += 1
            return InterruptedStreamResponse(
                [b'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n']
            )

        model = {
            "id": "mimo-v2.5",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {"messages": [{"role": "user", "content": "ping"}], "tools": []}

        with patch("urllib.request.urlopen", fake_urlopen), patch("mon_agent_server.llm.openai_compatible.time.sleep"):
            stream = await stream_openai_compatible(model, context, {"apiKey": "sk-test"})
            events = [event async for event in stream]

        self.assertEqual(attempts, 1)
        self.assertNotIn("provider_retry", [event["type"] for event in events])
        self.assertEqual(events[-1]["type"], "error")

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

    async def test_openai_compatible_preserves_reasoning_field_signature(self):
        def fake_urlopen(_request, timeout):
            return FakeStreamResponse(
                [
                    b'data: {"choices":[{"delta":{"reasoning":"inspect"},"finish_reason":null}]}\n\n',
                    b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
                    b"data: [DONE]\n\n",
                ]
            )

        model = {
            "id": "mimo-v2.5",
            "api": "openai-completions",
            "provider": "opencode-go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
        }
        context = {"messages": [{"role": "user", "content": [{"type": "text", "text": "read"}]}], "tools": []}

        with patch("urllib.request.urlopen", fake_urlopen):
            stream = await stream_openai_compatible(model, context, {"apiKey": "sk-test"})
            events = [event async for event in stream]

        thinking = events[-1]["message"]["content"][0]
        self.assertEqual(thinking["thinking"], "inspect")
        self.assertEqual(thinking["thinkingSignature"], "reasoning_content")


if __name__ == "__main__":
    unittest.main()
