import unittest
from unittest.mock import patch

from mon_agent_server.server import run_startup_self_awake_once


class FakeConfig:
    auth_dev_username = "admin"
    auth_dev_password = "password"


class FakeCoreClient:
    def __init__(self):
        self.persisted = None

    def login_for_token(self, username, password, client_id, client_type):
        self.login_args = (username, password, client_id, client_type)
        return "token-1"

    def list_self_awake_runs(self, token, limit):
        self.list_args = (token, limit)
        return [{"status": "succeeded", "next_wake_at": "2099-01-01T00:00:00Z"}]

    def persist_self_awake_run(self, token, decision, context):
        self.persisted = (token, decision, context)
        return {"id": 1}


class FakeApp:
    def __init__(self):
        self.config = FakeConfig()
        self.core_client = FakeCoreClient()


class StartupSelfAwakeTest(unittest.TestCase):
    def test_startup_self_awake_runs_even_when_future_wake_exists(self):
        app = FakeApp()
        decision = {
            "source": "agent",
            "mood": "平静",
            "current_desire": "启动检查",
            "should_interrupt_user": False,
            "action": {"type": "observe_only", "message": ""},
            "next_wake": {"after_minutes": 60, "reason": "继续观察"},
            "diary": {"title": "启动自醒", "content": "完成检查"},
        }

        with patch("mon_agent_server.server.run_self_awake_sync", return_value=decision) as run_self_awake:
            run_startup_self_awake_once(app)

        run_self_awake.assert_called_once()
        self.assertEqual(app.core_client.persisted[0], "token-1")
        self.assertEqual(app.core_client.persisted[1], decision)
        self.assertEqual(app.core_client.persisted[2]["trigger"], "monagent_server_startup")
        self.assertEqual(app.core_client.persisted[2]["last_state"]["next_wake_at"], "2099-01-01T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
