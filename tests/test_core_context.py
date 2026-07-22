import unittest

from mon_agent_server.core import CoreClient


class CoreContextTest(unittest.TestCase):
    def test_session_sync_separates_canonical_context_from_ui_payload(self):
        client = CoreClient("http://core.test")
        captured = {}
        client._request = lambda _path, _token, **kwargs: captured.update(kwargs["payload"]) or {"id": 1}
        context = [{"id": "evt_1", "sequence": 1, "type": "turn_started", "payload": {"runID": "run_1"}}]

        client.sync_agent_session(
            "token",
            {
                "id": "ses_1",
                "title": "测试",
                "time": {"updated": 1},
                "modelEvents": context,
                "characterRuntime": {"characterID": 7, "imageUrl": "/media/action.png"},
            },
        )

        self.assertEqual(captured["session_events_payload"], context)
        self.assertNotIn("modelEvents", captured["session_payload"])
        self.assertEqual(captured["session_payload"]["characterRuntime"]["characterID"], 7)

    def test_session_restore_returns_canonical_context(self):
        client = CoreClient("http://core.test")
        context = [
            {
                "id": "evt_1",
                "sequence": 1,
                "type": "assistant_message",
                "payload": {"role": "assistant", "content": [{"type": "toolCall", "id": "call_1", "name": "read"}]},
            },
            {
                "id": "evt_2",
                "sequence": 2,
                "type": "tool_result",
                "payload": {"role": "toolResult", "toolCallId": "call_1", "content": "ok"},
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
                    "session_payload": {
                        "id": "ses_1",
                        "title": "测试",
                        "time": {"created": 1, "updated": 1},
                        "characterRuntime": {"characterID": 7, "imageUrl": "/media/action.png"},
                    },
                    "session_events_payload": context,
                }
            ]
        }

        restored = client.get_agent_session("token", "ses_1")

        self.assertEqual(restored["modelEvents"], context)
        self.assertEqual(restored["info"]["characterRuntime"]["imageUrl"], "/media/action.png")

    def test_empty_event_stream_stays_empty(self):
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
                    "session_events_payload": [],
                }
            ]
        }

        restored = client.get_agent_session("token", "ses_old")

        self.assertEqual(restored["modelEvents"], [])


if __name__ == "__main__":
    unittest.main()
