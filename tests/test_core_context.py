import unittest

from mon_agent_server.core import CoreClient


class CoreContextTest(unittest.TestCase):
    def test_session_sync_separates_canonical_context_from_ui_payload(self):
        client = CoreClient("http://core.test")
        captured = {}
        client._request = lambda _path, _token, **kwargs: captured.update(kwargs["payload"]) or {"id": 1}
        context = [{"role": "toolResult", "toolCallId": "call_1", "content": [], "isError": False}]

        client.sync_agent_session(
            "token",
            {
                "id": "ses_1",
                "title": "测试",
                "time": {"updated": 1},
                "agentMessages": context,
            },
        )

        self.assertEqual(captured["agent_context_payload"], context)
        self.assertNotIn("agentMessages", captured["session_payload"])

    def test_session_restore_returns_canonical_context(self):
        client = CoreClient("http://core.test")
        context = [
            {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": "call_1", "name": "read", "arguments": {}}],
            },
            {
                "role": "toolResult",
                "toolCallId": "call_1",
                "toolName": "read",
                "content": [{"type": "text", "text": "ok"}],
                "isError": False,
            },
        ]
        client._request = lambda _path, _token, **_kwargs: {
            "results": [
                {
                    "id": 1,
                    "external_session_id": "ses_1",
                    "title": "测试",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                    "messages": [],
                    "agent_context_payload": context,
                }
            ]
        }

        restored = client.get_agent_session("token", "ses_1")

        self.assertEqual(restored["agentMessages"], context)

    def test_empty_context_uses_legacy_projection_fallback(self):
        client = CoreClient("http://core.test")
        client._request = lambda _path, _token, **_kwargs: {
            "results": [
                {
                    "id": 1,
                    "external_session_id": "ses_old",
                    "title": "旧会话",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                    "messages": [],
                    "agent_context_payload": [],
                }
            ]
        }

        restored = client.get_agent_session("token", "ses_old")

        self.assertIsNone(restored["agentMessages"])


if __name__ == "__main__":
    unittest.main()
