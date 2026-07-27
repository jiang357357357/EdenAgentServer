from __future__ import annotations

import unittest
import threading
from unittest.mock import patch

from mon_agent_server.brokers import PermissionBroker
from mon_agent_server.events import EventBus


class PermissionBrokerTest(unittest.TestCase):
    def test_default_mode_requires_approval(self) -> None:
        broker = PermissionBroker(EventBus())

        self.assertEqual(broker.mode(), {"mode": "restricted"})
        self.assertFalse(broker.is_always_allowed("write", "src/app.py"))

    def test_takeover_is_the_global_auto_allow_mode(self) -> None:
        broker = PermissionBroker(EventBus())

        self.assertEqual(broker.set_mode("takeover"), {"mode": "takeover"})
        self.assertTrue(broker.is_always_allowed("bash", "pytest"))

    def test_persisted_modes_are_isolated_by_user_scope_and_session(self) -> None:
        broker = PermissionBroker(EventBus())
        broker.hydrate_mode("takeover", "user-a", "ses-a")
        broker.hydrate_mode("ask", "user-b", "ses-b")

        self.assertEqual(broker.mode("user-a"), {"mode": "takeover"})
        self.assertEqual(broker.mode("user-b"), {"mode": "restricted"})
        self.assertTrue(broker.is_always_allowed("bash", "pytest", "ses-a"))
        self.assertFalse(broker.is_always_allowed("bash", "pytest", "ses-b"))

    def test_always_permission_is_scoped_to_session(self) -> None:
        broker = PermissionBroker(EventBus(), timeout_seconds=1)
        result: list[str] = []
        thread = threading.Thread(
            target=lambda: result.append(
                broker.ask(
                    {
                        "sessionID": "ses-a",
                        "permission": "访问工作区外路径",
                        "patterns": ["/home/user/.steam"],
                        "always": ["/home/user/.steam"],
                    }
                )
            ),
            daemon=True,
        )
        thread.start()
        for _ in range(100):
            if broker.list():
                break
            threading.Event().wait(0.001)
        self.assertTrue(broker.reply(broker.list()[0]["id"], "always"))
        thread.join(timeout=1)

        self.assertEqual(result, ["always"])
        self.assertTrue(
            broker.is_explicitly_allowed("访问工作区外路径", "/home/user/.steam", "ses-a")
        )
        self.assertFalse(
            broker.is_explicitly_allowed("访问工作区外路径", "/home/user/.steam", "ses-b")
        )

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

    def test_reply_wins_timeout_race_without_duplicate_terminal_event(self) -> None:
        class RecordingEvents:
            def __init__(self) -> None:
                self.items = []

            def emit(self, event) -> None:
                self.items.append(event)

        real_event = threading.Event
        wait_entered = real_event()
        release_wait = real_event()

        class FalseAfterReplyEvent:
            def wait(self, timeout=None):
                wait_entered.set()
                release_wait.wait(timeout=1)
                return False

            def set(self):
                return None

        events = RecordingEvents()
        broker = PermissionBroker(events, timeout_seconds=1)
        result: list[str] = []
        worker = threading.Thread(
            target=lambda: result.append(broker.ask({"sessionID": "ses-race", "permission": "write"})),
            daemon=True,
        )

        with patch("mon_agent_server.brokers.broker.threading.Event", return_value=FalseAfterReplyEvent()):
            worker.start()
            self.assertTrue(wait_entered.wait(timeout=1))
            request_id = broker.list()[0]["id"]
            self.assertTrue(broker.reply(request_id, "once"))
            release_wait.set()
            worker.join(timeout=1)

        self.assertEqual(result, ["once"])
        replied = [item for item in events.items if item["type"] == "permission.replied"]
        self.assertEqual(len(replied), 1)
        self.assertEqual(replied[0]["properties"]["reply"], "once")


if __name__ == "__main__":
    unittest.main()
