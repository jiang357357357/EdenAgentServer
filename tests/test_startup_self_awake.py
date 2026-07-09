import unittest
from unittest.mock import patch

from mon_agent_server.server import run_startup_self_awake_once


class FakeEnvironment:
    timezone = "Asia/Shanghai"
    locale = "zh-CN"
    country = "中国"
    region = "上海市"
    city = "上海"
    latitude = 31.2304
    longitude = 121.4737


class FakeConfig:
    auth_dev_username = "admin"
    auth_dev_password = "password"
    environment = FakeEnvironment()


class FakeCoreClient:
    def __init__(self):
        self.persisted = None
        self.list_called = False

    def login_for_token(self, username, password, client_id, client_type):
        self.login_args = (username, password, client_id, client_type)
        return "token-1"

    def list_self_awake_runs(self, token, limit):
        self.list_called = True
        return []

    def persist_self_awake_run(self, token, decision, context):
        self.persisted = (token, decision, context)
        return {"id": 1}


class FakeApp:
    def __init__(self):
        self.config = FakeConfig()
        self.core_client = FakeCoreClient()

    def environment_context_for_token(self, token):
        self.environment_token = token
        return {
            "timezone": "Asia/Shanghai",
            "locale": "zh-CN",
            "location": {
                "country": "中国",
                "region": "湖北省",
                "city": "武汉市",
                "district": "江夏区",
                "latitude": 30.57889,
                "longitude": 114.29212,
            },
        }


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
        self.assertNotIn("current_time_local", app.core_client.persisted[2])
        self.assertFalse(app.core_client.persisted[2]["current_time"].endswith("Z"))
        self.assertEqual(app.core_client.persisted[2]["wake"]["reason"], "server_startup")
        self.assertEqual(app.core_client.persisted[2]["environment"]["timezone"], "Asia/Shanghai")
        self.assertEqual(app.environment_token, "token-1")
        self.assertEqual(app.core_client.persisted[2]["environment"]["location"]["region"], "湖北省")
        self.assertEqual(app.core_client.persisted[2]["environment"]["location"]["city"], "武汉市")
        self.assertEqual(app.core_client.persisted[2]["environment"]["location"]["district"], "江夏区")
        self.assertIn("weekday", app.core_client.persisted[2]["environment"]["date"])
        self.assertNotIn("last_state", app.core_client.persisted[2])
        self.assertNotIn("user_activity", app.core_client.persisted[2])
        self.assertFalse(app.core_client.list_called)


if __name__ == "__main__":
    unittest.main()
