from __future__ import annotations

import unittest

from mon_agent_server.core.serializers import session_from_map
from mon_agent_server.store import SessionStore


class OrchestratorRunPersistenceTest(unittest.TestCase):
    def test_store_updates_a_run_without_duplicating_it(self) -> None:
        store = SessionStore()
        session = store.create_session("理解状态")
        run = {
            "orchestrationID": "orc_1",
            "userMessageID": "msg_user_1",
            "status": "running",
            "phase": "正在理解请求",
        }

        store.upsert_orchestrator_run(session["id"], run)
        store.upsert_orchestrator_run(
            session["id"],
            {**run, "status": "completed", "phase": "已理解请求", "summary": "用户需要帮助"},
        )

        runs = store.require_session(session["id"])["info"]["orchestratorRuns"]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["userMessageID"], "msg_user_1")
        self.assertEqual(runs[0]["status"], "completed")
        self.assertEqual(runs[0]["summary"], "用户需要帮助")

    def test_core_session_deserializer_restores_runs_from_session_payload(self) -> None:
        session = session_from_map(
            {
                "external_session_id": "ses_1",
                "title": "持久化理解状态",
                "created_at": "2026-07-24T00:00:00+08:00",
                "updated_at": "2026-07-24T00:01:00+08:00",
                "session_payload": {
                    "id": "ses_1",
                    "title": "持久化理解状态",
                    "orchestratorRuns": [
                        {
                            "orchestrationID": "orc_1",
                            "userMessageID": "msg_user_1",
                            "status": "completed",
                            "phase": "已理解请求",
                            "summary": "用户需要帮助",
                        }
                    ],
                    "time": {"created": 1, "updated": 2},
                },
            }
        )

        self.assertEqual(len(session["orchestratorRuns"]), 1)
        self.assertEqual(session["orchestratorRuns"][0]["orchestrationID"], "orc_1")
        self.assertEqual(session["orchestratorRuns"][0]["userMessageID"], "msg_user_1")


if __name__ == "__main__":
    unittest.main()
