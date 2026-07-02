import json
import unittest
from unittest.mock import patch

from mon_agent_server.model_stream import call_openai_compatible


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


class ModelStreamTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
