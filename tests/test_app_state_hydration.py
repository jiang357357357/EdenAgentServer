import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from mon_agent_server.app import AppState


class HydrationTest(unittest.TestCase):
    @staticmethod
    def app_with_fakes():
        calls = []
        fetch_started = threading.Event()
        allow_fetch = threading.Event()

        class CoreClient:
            @staticmethod
            def get_agent_session(token, session_id):
                calls.append(("core", token, session_id))
                fetch_started.set()
                allow_fetch.wait(timeout=2)
                return {
                    "info": {"id": session_id, "title": "历史会话"},
                    "messages": [{"info": {"id": "message-1"}, "parts": []}],
                    "modelEvents": [],
                }

        class Store:
            def __init__(self):
                self.hydrated = False

            def upsert_session_info(self, info):
                calls.append(("info", info["id"]))

            def hydrate_messages(self, session_id, messages, model_events):
                calls.append(("messages", session_id, len(messages), len(model_events)))
                self.hydrated = True

            def require_session(self, session_id):
                if not self.hydrated:
                    raise KeyError(session_id)
                return {"info": {"id": session_id}}

        class Runtime:
            @staticmethod
            def load_persisted_subagents(session_id):
                calls.append(("subagents", session_id))

            @staticmethod
            def backfill_session_title_async(session_id, token):
                calls.append(("title", session_id, token))

        class ConnectorManager:
            @staticmethod
            def reconcile_user(_token):
                raise AssertionError("session hydration must not reconcile connectors")

        app = AppState.__new__(AppState)
        app.hydrated_session_ids = set()
        app._hydrating_session_ids = set()
        app._hydration_condition = threading.Condition()
        app.core_client = CoreClient()
        app.store = Store()
        app.runtime = Runtime()
        app.connector_manager = ConnectorManager()
        return app, calls, fetch_started, allow_fetch

    def test_concurrent_session_hydration_fetches_core_once(self):
        app, calls, fetch_started, allow_fetch = self.app_with_fakes()

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(app.ensure_hydrated, "token", "session-1")
            self.assertTrue(fetch_started.wait(timeout=1))
            second = executor.submit(app.ensure_hydrated, "token", "session-1")
            time.sleep(0.05)
            allow_fetch.set()
            first.result(timeout=1)
            second.result(timeout=1)

        self.assertEqual(
            [call for call in calls if call[0] == "core"],
            [("core", "token", "session-1")],
        )
        self.assertIn("session-1", app.hydrated_session_ids)

    def test_hydration_does_not_reconcile_connectors(self):
        app, _, _, allow_fetch = self.app_with_fakes()
        allow_fetch.set()

        app.ensure_hydrated("token", "session-1")

        self.assertIn("session-1", app.hydrated_session_ids)


if __name__ == "__main__":
    unittest.main()
