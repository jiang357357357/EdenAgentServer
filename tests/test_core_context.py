import unittest

from mon_agent_server.core import CoreClient


class CoreContextTest(unittest.TestCase):
    def test_agent_permission_settings_use_persistent_core_endpoint(self):
        client = CoreClient("http://core.test")
        calls = []
        client._request = lambda path, token, method="GET", payload=None: calls.append(
            (path, token, method, payload)
        ) or {"permission_mode": "full_access"}

        self.assertEqual(client.get_agent_settings("token")["permission_mode"], "full_access")
        self.assertEqual(
            client.update_agent_settings("token", {"permission_mode": "restricted"})["permission_mode"],
            "full_access",
        )
        self.assertEqual(calls[0], ("/api/agent/settings/my/", "token", "GET", None))
        self.assertEqual(
            calls[1],
            ("/api/agent/settings/my/", "token", "PATCH", {"permission_mode": "restricted"}),
        )

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

    def test_session_sync_and_restore_preserves_per_character_performance_state(self):
        client = CoreClient("http://core.test")
        captured = {}
        client._request = lambda _path, _token, **kwargs: captured.update(kwargs["payload"]) or {"id": 1}
        performances = {
            "9": {
                "current": {"characterID": 9, "action": {"name": "抬手强调"}},
                "recent": [{"actionName": "抬手强调"}],
            }
        }

        client.sync_agent_session(
            "token",
            {
                "id": "ses_actions",
                "title": "多人会话",
                "characterPerformances": performances,
                "time": {"created": 1, "updated": 2},
            },
        )
        stored_payload = captured["session_payload"]
        self.assertEqual(stored_payload["characterPerformances"], performances)

        client._request = lambda _path, _token, **_kwargs: {
            "results": [
                {
                    "id": 1,
                    "external_session_id": "ses_actions",
                    "title": "多人会话",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                    "session_payload": stored_payload,
                    "messages": [],
                }
            ]
        }

        restored = client.get_agent_session("token", "ses_actions")
        self.assertEqual(restored["info"]["characterPerformances"], performances)


if __name__ == "__main__":
    unittest.main()
