from __future__ import annotations

import asyncio
import threading
import unittest

from mon_agent_server.runtime.host import RuntimeHost


class RuntimeHostTest(unittest.TestCase):
    def test_reuses_one_long_lived_event_loop(self) -> None:
        host = RuntimeHost("runtime-host-test")

        async def loop_identity() -> int:
            return id(asyncio.get_running_loop())

        try:
            first = host.submit(loop_identity()).result(timeout=2)
            second = host.submit(loop_identity()).result(timeout=2)
        finally:
            host.close()

        self.assertEqual(first, second)
        self.assertFalse(host.running)

    def test_close_cancels_background_tasks(self) -> None:
        host = RuntimeHost("runtime-host-cancel-test")
        cancelled = threading.Event()

        async def wait_forever() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        host.submit(wait_forever())
        host.close()

        self.assertTrue(cancelled.wait(timeout=2))
