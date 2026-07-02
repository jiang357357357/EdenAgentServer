import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from mon_agent_server.prompts import fallback_self_awake_decision, parse_self_awake_decision
from mon_agent_server.self_awake import (
    SelfAwakeRuntimeConfig,
    run_self_awake_agent,
)


class FakeConfig:
    workspace_root = Path(__file__).resolve().parents[2]


class FakeCoreClient:
    pass


class FakeApp:
    config = FakeConfig()
    core_client = FakeCoreClient()


class FakeAgent:
    def __init__(self, _options):
        self.state = SimpleNamespace(messages=[])
        self.listeners = []

    def subscribe(self, listener):
        self.listeners.append(listener)

    async def prompt(self, _message):
        message = {
            "role": "assistant",
            "content": [{"type": "text", "text": ""}],
            "errorMessage": "模型请求失败: 403 Forbidden",
        }
        self.state.messages.append(message)
        for listener in self.listeners:
            listener({"type": "message_end", "message": message}, None)


class SelfAwakePromptTest(unittest.TestCase):
    def test_parse_self_awake_decision_from_fenced_json(self):
        decision = parse_self_awake_decision(
            """
```json
{
  "mood": "平静",
  "current_desire": "确认提醒",
  "observations": ["没有错误", "没有到期提醒"],
  "should_interrupt_user": false,
  "action": {"type": "observe_only", "message": "继续观察"},
  "next_wake": {"after_minutes": 60, "reason": "稍后再看"},
  "diary": {"title": "自醒", "content": "完成一次检查"}
}
```
"""
        )

        self.assertEqual(decision["action"]["type"], "observe_only")
        self.assertEqual(decision["next_wake"]["after_minutes"], 60)
        self.assertEqual(decision["source"], "agent")

    def test_fallback_self_awake_decision_shape(self):
        decision = fallback_self_awake_decision({"user_activity": "服务启动"}, "模型不可用", {"name": "小蒙"})

        self.assertEqual(decision["source"], "fallback")
        self.assertFalse(decision["should_interrupt_user"])
        self.assertIn("模型不可用", decision["error"])


class SelfAwakeTest(unittest.IsolatedAsyncioTestCase):
    async def test_model_error_message_is_raised_before_json_parse(self):
        runtime_config = SelfAwakeRuntimeConfig(
            model={"id": "minimax-m2.7", "provider": "opencode-go", "input": ["text"], "reasoning": False},
            api_key="sk-test",
            label="opencode-go/minimax-m2.7",
            source="core",
            core={"character": {"name": "测试角色"}},
            supports_images=False,
            thinking_level="off",
        )

        with (
            patch("mon_agent_server.self_awake.Agent", FakeAgent),
            patch("mon_agent_server.self_awake.create_mon_agent_tools", return_value=[]),
        ):
            with self.assertRaisesRegex(RuntimeError, "403 Forbidden"):
                await run_self_awake_agent({"context": {"trigger": "test"}}, FakeApp(), "token-1", runtime_config)


if __name__ == "__main__":
    unittest.main()
