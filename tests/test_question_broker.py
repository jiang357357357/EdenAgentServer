from __future__ import annotations

import threading
import unittest

from mon_agent_server.brokers import QuestionBroker
from mon_agent_server.events import EventBus


class QuestionBrokerTest(unittest.TestCase):
    def test_reject_all_releases_only_matching_session_waiters(self) -> None:
        broker = QuestionBroker(EventBus())
        results: dict[str, object] = {}

        def ask(session_id: str) -> None:
            results[session_id] = broker.ask({"sessionID": session_id, "question": session_id})

        workers = [threading.Thread(target=ask, args=(session_id,), daemon=True) for session_id in ("a", "b")]
        for worker in workers:
            worker.start()
        for _ in range(100):
            if len(broker.list()) == 2:
                break
            threading.Event().wait(0.001)

        self.assertEqual(broker.reject_all("a", "session_deleted"), 1)
        workers[0].join(timeout=1)
        self.assertIsNone(results.get("a"))
        self.assertEqual([item["sessionID"] for item in broker.list()], ["b"])

        self.assertEqual(broker.reject_all("b"), 1)
        workers[1].join(timeout=1)
        self.assertIsNone(results.get("b"))
        self.assertEqual(broker.list(), [])


if __name__ == "__main__":
    unittest.main()
