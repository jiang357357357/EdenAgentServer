import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from mon_agent_server.prompts import build_agent_system_prompt, build_user_chat_task_prompt, fallback_self_awake_decision, parse_self_awake_decision
from mon_agent_server.self_awake import (
    SelfAwakeRuntimeConfig,
    build_self_awake_environment,
    final_assistant_usage,
    render_self_awake_decision,
    render_self_awake_request,
    run_self_awake_and_persist_sync,
    run_self_awake_agent,
    start_self_awake_run_async,
)


class FakeConfig:
    workspace_root = Path(__file__).resolve().parents[2]
    display_enabled = False


class FakeCoreClient:
    def __init__(self):
        self.persisted = []

    def persist_self_awake_run(self, token, decision, context):
        self.persisted.append((token, decision, context))
        return {"id": 123}


class FakeApp:
    config = FakeConfig()
    core_client = FakeCoreClient()


class FakeProfileApp(FakeApp):
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
                "updated_at": "2026-07-05T08:07:49.741Z",
            },
        }


class FakeDisplayConfig(FakeConfig):
    display_enabled = True


class FakeDisplayApp(FakeApp):
    config = FakeDisplayConfig()


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


class CapturingAgent(FakeAgent):
    system_prompts = []

    def __init__(self, options):
        super().__init__(options)
        self.system_prompts.append((options.initial_state or {}).get("systemPrompt") or "")


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

    def test_agent_system_prompt_includes_extended_character_context(self):
        prompt = build_agent_system_prompt(
            {
                "assistant": {"name": "默认晚棠", "instructions": "保持温柔但主动。"},
                "character": {
                    "name": "江梦晚",
                    "signature": "前辈~",
                    "description": "直属学妹。",
                    "personality": "表里如一的小恶魔。",
                    "social_relations": "用户是前辈。",
                    "background": "私立月之咲学园。",
                    "appearance": "校服、短发。",
                    "system_prompt": "只在需要时主动提醒。",
                    "world_names": ["月之咲"],
                    "affection": 0.7,
                    "trust": 0.8,
                    "attachment": 0.6,
                    "possessive": 0.3,
                    "visual_preference": "static",
                    "visual_actions": [{"name": "待机", "intent": "idle"}],
                    "visual_action_groups": [{"name": "待机动作组", "trigger": "idle"}],
                },
                "aiEntity": {"api_key": "sk-secret"},
            },
            source="self_awake",
        )

        self.assertIn("性格内核：表里如一的小恶魔。", prompt)
        self.assertIn("社会关系：用户是前辈。", prompt)
        self.assertIn("所属世界：月之咲", prompt)
        self.assertIn("当前关系状态：喜爱 0.7，信任 0.8，依恋 0.6，占有 0.3", prompt)
        self.assertIn("助手指令：保持温柔但主动。", prompt)
        self.assertNotIn("视觉偏好", prompt)
        self.assertNotIn("可用视觉动作", prompt)
        self.assertNotIn("视觉动作组", prompt)
        self.assertNotIn("sk-secret", prompt)

    def test_user_chat_prompt_keeps_visual_character_context(self):
        prompt = build_agent_system_prompt(
            {
                "character": {
                    "name": "江梦晚",
                    "visual_preference": "static",
                    "visual_actions": [{"name": "待机", "intent": "idle"}],
                    "visual_action_groups": [{"name": "待机动作组", "trigger": "idle"}],
                },
            },
            source="user_chat",
            current_character_action={
                "action": {"name": "思考", "intent": "think", "static_image_url": "/media/actions/think.png"},
                "imageUrl": "/media/actions/think.png",
                "source": "default",
            },
        )

        self.assertIn("视觉偏好：static", prompt)
        self.assertIn("可用视觉动作", prompt)
        self.assertIn("视觉动作组", prompt)
        self.assertIn("当前前端显示动作：思考", prompt)
        self.assertIn("当前动作意图：think", prompt)
        self.assertIn("每轮生成最终正文前必须先调用 switch_character_action 一次", prompt)

    def test_user_chat_task_prompt_requires_character_action_adjustment(self):
        prompt = build_user_chat_task_prompt("你好")

        self.assertIn("在最终回复正文前先调用 switch_character_action", prompt)

    def test_start_self_awake_run_async_returns_accepted_without_running_inline(self):
        with patch("mon_agent_server.self_awake.threading.Thread") as thread_cls:
            accepted = start_self_awake_run_async({"context": {"trigger": "test"}}, FakeApp(), "token-1")

        self.assertTrue(accepted["accepted"])
        self.assertEqual(accepted["status"], "queued")
        self.assertTrue(str(accepted["async_run_id"]).startswith("selfawakejob_"))
        thread_cls.assert_called_once()
        thread_cls.return_value.start.assert_called_once()

    def test_build_self_awake_environment_includes_calendar_awareness(self):
        with patch("mon_agent_server.self_awake.self_awake_now", return_value=datetime(2026, 2, 17, 8, 30, tzinfo=ZoneInfo("Asia/Shanghai"))):
            environment = build_self_awake_environment(
                FakeApp(),
                {
                    "timezone": "Asia/Shanghai",
                    "locale": "zh-CN",
                    "location": {"country": "中国", "region": "湖北省", "city": "武汉市"},
                },
            )

        self.assertEqual(environment["date"]["local"], "2026-02-17")
        self.assertEqual(environment["date"]["lunar"]["text"], "正月初一")
        self.assertEqual(environment["date"]["holidays"][0]["name"], "春节")
        self.assertNotIn("nearby_festivals", environment["date"])

    def test_run_self_awake_and_persist_sync_writes_core(self):
        decision = {
            "mood": "平静",
            "current_desire": "记录",
            "observations": [],
            "should_interrupt_user": False,
            "action": {"type": "write_diary", "message": "ok", "payload": {}},
            "next_wake": {"after_minutes": 60, "reason": "稍后"},
            "diary": {"title": "自醒", "content": "完成"},
            "source": "agent",
            "error": "",
        }
        app = FakeApp()

        with (
            patch("mon_agent_server.self_awake.run_self_awake_sync", return_value=decision),
            patch("mon_agent_server.self_awake.update_self_awake_timer_from_decision") as update_timer,
        ):
            result = run_self_awake_and_persist_sync({"context": {"trigger": "test"}}, app, "token-1", "job-1")

        self.assertFalse(result["accepted"])
        self.assertEqual(result["server_run_id"], 123)
        self.assertEqual(result["server_error"], "")
        self.assertEqual(result["async_run_id"], "job-1")
        update_timer.assert_called_once_with(app, decision, "job-1")
        self.assertEqual(app.core_client.persisted[-1][0], "token-1")

    def test_run_self_awake_and_persist_sync_uses_user_environment(self):
        decision = {
            "mood": "平静",
            "current_desire": "记录",
            "observations": [],
            "should_interrupt_user": False,
            "action": {"type": "write_diary", "message": "ok", "payload": {}},
            "next_wake": {"after_minutes": 60, "reason": "稍后"},
            "diary": {"title": "自醒", "content": "完成"},
            "source": "agent",
            "error": "",
        }
        app = FakeProfileApp()

        with (
            patch("mon_agent_server.self_awake.run_self_awake_sync", return_value=decision),
            patch("mon_agent_server.self_awake.update_self_awake_timer_from_decision"),
        ):
            run_self_awake_and_persist_sync({"context": {"trigger": "test"}}, app, "token-1", "job-1")

        persisted_context = app.core_client.persisted[-1][2]
        self.assertEqual(app.environment_token, "token-1")
        self.assertEqual(persisted_context["environment"]["location"]["city"], "武汉市")
        self.assertEqual(persisted_context["environment"]["location"]["district"], "江夏区")
        self.assertEqual(persisted_context["environment"]["location"]["region"], "湖北省")
        self.assertEqual(persisted_context["environment"]["location"]["updated_at"], "2026-07-05T16:07:49.741000+08:00")
        self.assertNotIn("Z", persisted_context["environment"]["location"]["updated_at"])

    def test_render_self_awake_request_uses_display_table(self):
        runtime_config = SelfAwakeRuntimeConfig(
            model={"id": "minimax-m2.7", "provider": "opencode-go", "input": ["text"], "reasoning": False},
            api_key="sk-secret",
            label="opencode-go/minimax-m2.7",
            source="core",
            core=None,
            supports_images=False,
            thinking_level="off",
        )

        with patch("mon_agent_server.display.render_decision_table") as render_table:
            render_self_awake_request(
                FakeDisplayApp(),
                "selfawake_1",
                {"trigger": "test", "current_time": "2026-07-04T12:00:00+08:00"},
                runtime_config,
                {"name": "测试角色"},
                "system prompt",
                "user prompt",
                ["list_due_memos", "set_self_awake_timer"],
            )

        render_table.assert_called_once()
        args, kwargs = render_table.call_args
        payload = args[0]
        self.assertEqual(kwargs["stage_name"], "[AGENT-SELFAWAKE] 自醒请求")
        self.assertEqual(kwargs["character_name"], "测试角色")
        self.assertEqual(payload["使用工具"], "自醒")
        self.assertEqual(payload["工具参数"]["模型"], "opencode-go/minimax-m2.7")
        self.assertEqual(payload["工具参数"]["工具数量"], 2)
        self.assertIn("system prompt", payload["内容"]["系统提示词"])
        self.assertNotIn("sk-secret", str(payload))

    def test_render_self_awake_decision_includes_token_usage(self):
        runtime_config = SelfAwakeRuntimeConfig(
            model={"id": "minimax-m2.7", "provider": "opencode-go", "input": ["text"], "reasoning": False},
            api_key="sk-secret",
            label="opencode-go/minimax-m2.7",
            source="core",
            core=None,
            supports_images=False,
            thinking_level="off",
        )
        decision = {
            "mood": "平静",
            "current_desire": "记录",
            "observations": [],
            "should_interrupt_user": False,
            "action": {"type": "write_diary", "message": "ok", "payload": {}},
            "next_wake": {"after_minutes": 60, "reason": "稍后"},
            "diary": {"title": "自醒", "content": "完成"},
            "source": "agent",
            "error": "",
        }

        with patch("mon_agent_server.display.render_decision_table") as render_table:
            render_self_awake_decision(
                FakeDisplayApp(),
                decision,
                runtime_config,
                1234,
                {"name": "测试角色"},
                {"input": 100, "cacheRead": 70, "cacheMiss": 30, "output": 25, "totalTokens": 125},
            )

        payload = render_table.call_args.args[0]
        self.assertEqual(payload["决策类型"], "写工作日记")
        self.assertEqual(payload["使用工具"], "自醒")
        self.assertEqual(payload["工具参数"]["缓存命中 Tokens"], 70)
        self.assertEqual(payload["工具参数"]["缓存未命中 Tokens"], 30)
        self.assertEqual(payload["工具参数"]["输出 Tokens"], 25)
        self.assertEqual(payload["工具参数"]["总 Tokens"], 125)

    def test_final_assistant_usage_extracts_last_assistant_usage(self):
        usage = final_assistant_usage(
            [
                {"role": "assistant", "usage": {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4, "totalTokens": 10}},
                {"role": "user"},
                {"role": "assistant", "usage": {"input": 100, "cacheRead": 70, "cacheMiss": 30, "output": 25, "totalTokens": 125}},
            ]
        )

        self.assertEqual(usage["input"], 100)
        self.assertEqual(usage["cacheRead"], 70)
        self.assertEqual(usage["cacheMiss"], 30)
        self.assertEqual(usage["output"], 25)
        self.assertEqual(usage["totalTokens"], 125)


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

    async def test_self_awake_agent_uses_full_core_context_for_system_prompt(self):
        runtime_config = SelfAwakeRuntimeConfig(
            model={"id": "minimax-m2.7", "provider": "opencode-go", "input": ["text"], "reasoning": False},
            api_key="sk-test",
            label="opencode-go/minimax-m2.7",
            source="core",
            core={
                "assistant": {"name": "默认晚棠", "instructions": "保持温柔但主动。"},
                "character": {
                    "name": "江梦晚",
                    "description": "直属学妹。",
                    "personality": "表里如一的小恶魔。",
                    "trust": 0.8,
                },
                "aiEntity": {"api_key": "sk-secret"},
            },
            supports_images=False,
            thinking_level="off",
        )
        CapturingAgent.system_prompts = []

        with (
            patch("mon_agent_server.self_awake.Agent", CapturingAgent),
            patch("mon_agent_server.self_awake.create_mon_agent_tools", return_value=[]),
        ):
            with self.assertRaisesRegex(RuntimeError, "403 Forbidden"):
                await run_self_awake_agent({"context": {"trigger": "test"}}, FakeApp(), "token-1", runtime_config)

        self.assertEqual(len(CapturingAgent.system_prompts), 1)
        prompt = CapturingAgent.system_prompts[0]
        self.assertIn("助手指令：保持温柔但主动。", prompt)
        self.assertIn("性格内核：表里如一的小恶魔。", prompt)
        self.assertIn("当前关系状态：信任 0.8", prompt)
        self.assertNotIn("sk-secret", prompt)


if __name__ == "__main__":
    unittest.main()
