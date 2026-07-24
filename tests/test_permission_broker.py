from __future__ import annotations

import unittest
import threading

from mon_agent_server.brokers import PermissionBroker
from mon_agent_server.events import EventBus


class PermissionBrokerTest(unittest.TestCase):
    def test_default_mode_requires_approval(self) -> None:
        broker = PermissionBroker(EventBus())

        self.assertEqual(broker.mode(), {"mode": "ask"})
        self.assertFalse(broker.is_always_allowed("write", "src/app.py"))

    def test_full_access_remains_explicit_opt_in(self) -> None:
        broker = PermissionBroker(EventBus())

        self.assertEqual(broker.set_mode("full_access"), {"mode": "full_access"})
        self.assertTrue(broker.is_always_allowed("bash", "pytest"))

    def test_permission_request_times_out_and_is_cleaned_up(self) -> None:
        broker = PermissionBroker(EventBus(), timeout_seconds=0.01)

        self.assertEqual(broker.ask({"sessionID": "ses-1", "permission": "write"}), "reject")
        self.assertEqual(broker.list(), [])

    def test_reject_all_releases_matching_waiters(self) -> None:
        broker = PermissionBroker(EventBus(), timeout_seconds=1)
        result: list[str] = []
        thread = threading.Thread(
            target=lambda: result.append(broker.ask({"sessionID": "ses-1", "permission": "bash"})),
            daemon=True,
        )
        thread.start()
        for _ in range(100):
            if broker.list():
                break
            threading.Event().wait(0.001)

        self.assertEqual(broker.reject_all("ses-1"), 1)
        thread.join(timeout=1)
        self.assertEqual(result, ["reject"])
        self.assertEqual(broker.list(), [])


if __name__ == "__main__":
    unittest.main()
