import unittest

from mon_agent_server.prompts import fallback_self_awake_decision, parse_self_awake_decision


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


if __name__ == "__main__":
    unittest.main()
