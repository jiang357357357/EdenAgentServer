from datetime import datetime
import unittest
from zoneinfo import ZoneInfo

from mon_agent_server.config.environment import current_time_context
from mon_agent_server.prompts.builder import build_environment_awareness_section


class EnvironmentTimeTest(unittest.TestCase):
    def test_current_time_uses_configured_timezone_and_exposes_stable_fields(self):
        clock = current_time_context(
            {"timezone": "Asia/Shanghai"},
            datetime(2026, 7, 29, 9, 8, 7, tzinfo=ZoneInfo("Asia/Shanghai")),
        )

        self.assertEqual(clock["local_datetime"], "2026-07-29 09:08:07")
        self.assertEqual(clock["weekday"], "星期三")
        self.assertEqual(clock["utc_offset"], "UTC+08:00")
        self.assertEqual(clock["iso_datetime"], "2026-07-29T09:08:07+08:00")

    def test_environment_prompt_contains_current_clock_facts(self):
        prompt = build_environment_awareness_section(
            {"timezone": "Asia/Shanghai", "locale": "zh-CN", "runtime": {"operating_system": "Linux"}}
        )

        self.assertIn("当前本地时间：", prompt)
        self.assertIn("UTC+08:00", prompt)
        self.assertIn("当前 ISO 时间：", prompt)
