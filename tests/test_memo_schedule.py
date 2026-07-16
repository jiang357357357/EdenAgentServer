from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from mon_agent_server.tools.memo_schedule import (
    resolve_memo_schedule_request_dir,
    submit_memo_schedule_refresh,
)


class MemoScheduleRequestTest(unittest.TestCase):
    def test_submit_refresh_writes_atomic_request_for_monos(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            agent_root = root / "Agent"
            base_os_root = root / "Backend" / "BaseOs"
            agent_root.mkdir(parents=True)
            base_os_root.mkdir(parents=True)
            (base_os_root / ".monconfig").write_text(
                "[memo]\nDATA_DIR=Data/MemoScheduler\n", encoding="utf-8"
            )

            request = submit_memo_schedule_refresh(
                agent_root,
                reason="memo_created",
                memo={
                    "id": 12,
                    "title": "检查服务器",
                    "trigger_at": "2026-07-16T18:30:00+08:00",
                },
            )

            request_dir = resolve_memo_schedule_request_dir(agent_root)
            files = list(request_dir.glob("*.json"))
            self.assertIsNotNone(request)
            self.assertEqual(len(files), 1)
            self.assertNotEqual(files[0].suffix, ".tmp")
            self.assertIn("memo_created", files[0].read_text(encoding="utf-8"))
