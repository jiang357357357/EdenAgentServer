from __future__ import annotations

import unittest
from types import SimpleNamespace

from mon_agent_server.http.routes.speech import handle_speech


class FakeCoreClient:
    def __init__(self) -> None:
        self.synced_session = None

    def sync_agent_message(self, token, session, message):
        self.synced_session = session

    def synthesize_speech(self, *args):
        return {"success": True, "audio_url": "/media/test.wav"}


class FakeHandler:
    def __init__(self) -> None:
        message = {"info": {"id": "message-1", "role": "assistant"}, "parts": []}
        session = {"info": {"id": "session-1", "title": "test"}, "messages": [message]}
        core_client = FakeCoreClient()
        self.app = SimpleNamespace(
            ensure_hydrated=lambda token, session_id: None,
            store=SimpleNamespace(require_session=lambda session_id: session),
            core_client=core_client,
        )
        self.headers = {"Authorization": "Token test-token"}
        self.response = None

    def read_json_body(self):
        return {
            "session_id": "session-1",
            "message_id": "message-1",
            "segment_group_id": "text-1",
            "group_index": 0,
            "sequence": 0,
            "text": "测试语音",
            "config_id": 3,
            "mode": "all",
        }

    def json_response(self, body, status=200):
        self.response = (body, status)


class SpeechRouteTests(unittest.TestCase):
    def test_synthesis_syncs_canonical_session_info(self):
        handler = FakeHandler()

        handled = handle_speech(handler, "/speech/synthesize", {}, "POST")

        self.assertTrue(handled)
        self.assertEqual(handler.response[1], 200)
        self.assertEqual(handler.app.core_client.synced_session["id"], "session-1")


if __name__ == "__main__":
    unittest.main()
