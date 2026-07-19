import unittest
from unittest.mock import Mock

from mon_agent_server.core import CoreClient
from mon_agent_server.core.serializers import session_from_map
from mon_agent_server.store import SessionStore


DIRECTOR_RUN = {
    "planID": "plan_1",
    "userMessageID": "msg_user_1",
    "source": "model",
    "scene": {"domain": "social", "interactionType": "conversation", "confidence": 0.9, "summary": "聊天"},
    "execution": {"mode": "ensemble", "observationStrategy": "none"},
    "beats": [{"assistantID": 1, "intent": "回应", "speechAct": "respond", "addressTo": "user"}],
    "status": "planned",
    "activeBeatIndex": None,
    "completedBeatIndexes": [],
    "participantCount": 2,
}


class DirectorRunPersistenceTest(unittest.TestCase):
    def test_store_updates_a_run_without_duplicating_it(self):
        store = SessionStore()
        session = store.create_session("导演状态")
        store.upsert_director_run(session["id"], DIRECTOR_RUN)
        store.upsert_director_run(
            session["id"],
            {**DIRECTOR_RUN, "status": "running", "activeBeatIndex": 0},
        )

        runs = store.require_session(session["id"])["info"]["directorRuns"]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["status"], "running")
        self.assertEqual(runs[0]["activeBeatIndex"], 0)

    def test_core_session_deserializer_restores_full_director_run(self):
        session = session_from_map(
            {
                "external_session_id": "ses_1",
                "title": "多人聊天",
                "created_at": "2026-07-20T00:00:00+08:00",
                "updated_at": "2026-07-20T00:01:00+08:00",
                "director_runs": [
                    {
                        "external_plan_id": "plan_1",
                        "external_user_message_id": "msg_user_1",
                        "source": "model",
                        "scene_payload": DIRECTOR_RUN["scene"],
                        "execution_payload": DIRECTOR_RUN["execution"],
                        "beats_payload": DIRECTOR_RUN["beats"],
                        "status": "completed",
                        "completed_beat_indexes": [0],
                        "participant_count": 2,
                        "created_at": "2026-07-20T00:00:10+08:00",
                        "updated_at": "2026-07-20T00:00:20+08:00",
                    }
                ],
            }
        )

        run = session["directorRuns"][0]
        self.assertEqual(run["planID"], "plan_1")
        self.assertEqual(run["userMessageID"], "msg_user_1")
        self.assertEqual(run["beats"], DIRECTOR_RUN["beats"])
        self.assertEqual(run["status"], "completed")

    def test_core_client_sends_the_complete_run_to_the_dedicated_endpoint(self):
        client = CoreClient("http://core.test")
        client.sync_agent_session = Mock(return_value={"id": 17})
        client._request = Mock(return_value={"external_plan_id": "plan_1"})

        client.sync_agent_director_run(
            "token",
            {"id": "ses_1"},
            DIRECTOR_RUN,
        )

        path, token = client._request.call_args.args
        payload = client._request.call_args.kwargs["payload"]
        self.assertEqual(path, "/api/agent/sessions/17/director-runs/")
        self.assertEqual(token, "token")
        self.assertEqual(payload["external_user_message_id"], "msg_user_1")
        self.assertEqual(payload["beats_payload"], DIRECTOR_RUN["beats"])
        self.assertEqual(payload["status"], "planned")


if __name__ == "__main__":
    unittest.main()
