from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from mon_agent_server.speech import SpeechCache


class SpeechCacheTests(unittest.TestCase):
    def test_reuses_audio_for_the_same_message_segment(self) -> None:
        calls = 0
        audio = b"RIFF-test-wave"

        def producer():
            nonlocal calls
            calls += 1
            return {"success": True, "audio_data": base64.b64encode(audio).decode("ascii"), "audio_url": None}

        with tempfile.TemporaryDirectory() as directory:
            cache = SpeechCache(Path(directory))
            arguments = {
                "session_id": "ses_1",
                "message_id": "msg_1",
                "segment_id": "part_1:0",
                "config_id": 7,
                "mode": "text_only",
                "text": "你好",
                "producer": producer,
            }
            first = cache.synthesize(**arguments)
            second = cache.synthesize(**arguments)

        self.assertEqual(calls, 1)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(base64.b64decode(second["audio_data"]), audio)

    def test_text_change_creates_a_new_cache_entry(self) -> None:
        calls = 0

        def producer():
            nonlocal calls
            calls += 1
            return {"success": True, "audio_data": base64.b64encode(b"audio").decode("ascii")}

        with tempfile.TemporaryDirectory() as directory:
            cache = SpeechCache(Path(directory))
            common = {
                "session_id": "ses_1",
                "message_id": "msg_1",
                "segment_id": "part_1:0",
                "config_id": 7,
                "mode": "text_only",
                "producer": producer,
            }
            cache.synthesize(text="第一版", **common)
            cache.synthesize(text="第二版", **common)

        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
