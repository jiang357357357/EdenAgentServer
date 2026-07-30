import asyncio
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from mon_agent_server.core import CoreClient
from mon_agent_server.prompts import build_agent_system_prompt, build_self_awake_task_prompt, build_user_chat_task_prompt, fallback_self_awake_decision, parse_self_awake_decision
from mon_agent_server.self_awake import (
    SelfAwakeRuntimeConfig,
    build_self_awake_environment,
    ensure_self_awake_notification,
    finalize_memo_due_notification,
    final_assistant_usage,
    memo_due_items,
    normalize_self_awake_event,
    render_self_awake_decision,
    render_self_awake_request,
    run_self_awake_and_persist_sync,
    run_self_awake_agent,
    self_awake_notification_payload,
    start_self_awake_run_async,
)
from mon_agent_server.self_awake.permissions import self_awake_before_tool_call
from mon_agent_server.self_awake.contract import normalize_self_awake_request
from mon_agent_server.self_awake.runner import run_self_awake


class FakeConfig:
    workspace_root = Path(__file__).resolve().parents[2]
    display_enabled = False


class FakeCoreClient:
    def __init__(self):
        self.persisted = []
        self.marked_memos = []
        self.completed_memos = []

    def persist_self_awake_pending(self, token, context, external_run_id):
        self.pending = (token, context, external_run_id)
        return {"id": 122}

    def persist_self_awake_run(self, token, decision, context, *, external_run_id=None):
        self.persisted.append((token, decision, context, external_run_id))
        return {"id": 123}

    def mark_memo_triggered(self, token, memo_id):
        self.marked_memos.append((token, memo_id))
        return {"id": memo_id, "kind": "reminder", "status": "active"}

    def complete_memo(self, token, memo_id):
        self.completed_memos.append((token, memo_id))
        return {"id": memo_id, "kind": "reminder", "status": "done"}


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


class FakeNotifyTool:
    name = "notify_user"

    def __init__(self):
        self.calls = []

    async def run(self, tool_call_id, params):
        self.calls.append((tool_call_id, params))
        return {"details": {"delivered_channels": ["email" if params["priority"] == "high" else "qq"]}}


class InlineThread:
    def __init__(self, *, target, **_kwargs):
        self.target = target

    def start(self):
        self.target()


class CapturingAgent(FakeAgent):
    system_prompts = []

    def __init__(self, options):
        super().__init__(options)
        self.system_prompts.append((options.initial_state or {}).get("systemPrompt") or "")


class DuplicateNotifyAgent(FakeAgent):
    async def prompt(self, _message):
        events = [
            {"type": "tool_execution_start", "toolName": "notify_user", "toolCallId": "notify-1"},
            {"type": "tool_execution_end", "toolName": "notify_user", "toolCallId": "notify-1", "isError": False},
            {"type": "tool_execution_start", "toolName": "notify_user", "toolCallId": "notify-2"},
            {
                "type": "tool_execution_end",
                "toolName": "notify_user",
                "toolCallId": "notify-2",
                "isError": True,
                "error": "本轮重复通知已拦截",
            },
        ]
        for event in events:
            for listener in self.listeners:
                listener(event, None)
        self.state.messages.append(
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "{}"}],
            }
        )


class SelfAwakePromptTest(unittest.TestCase):
    def test_run_self_awake_preserves_enrichment_error(self):
        with patch(
            "mon_agent_server.self_awake.runner.enrich_self_awake_request",
            side_effect=ValueError("enrichment failed"),
        ):
            with self.assertRaisesRegex(ValueError, "enrichment failed"):
                asyncio.run(run_self_awake({}, FakeApp(), "token"))

    def test_v1_contract_preserves_stable_job_identity(self):
        request = normalize_self_awake_request(
            {
                "schema_version": "self-awake.v1",
                "job_id": "job-1",
                "event_id": "event-1",
                "idempotency_key": "key-1",
                "context": {"event": {"source": "monos", "event_id": "event-1"}},
            }
        )

        self.assertEqual(request["job_id"], "job-1")
        self.assertEqual(request["event_id"], "event-1")
        self.assertEqual(request["idempotency_key"], "key-1")

    def test_list_self_awake_runs_page_calculates_missing_total_pages(self):
        client = CoreClient("http://core.test")
        client._request = lambda *_args, **_kwargs: {"count": 41, "results": []}

        page = client.list_self_awake_runs_page("token", page=1, page_size=20)

        self.assertEqual(page["total_pages"], 3)

    def test_persist_self_awake_run_promotes_event_fields(self):
        client = CoreClient("http://core.test")
        captured = {}

        def capture_request(path, token, method="GET", payload=None):
            captured.update({"path": path, "token": token, "method": method, "payload": payload})
            return {"id": 12}

        client._request = capture_request
        client.persist_self_awake_run(
            "token-1",
            {
                "mood": "平静",
                "next_wake": {"after_minutes": 60, "reason": "继续观察"},
                "diary": {"title": "定时自醒", "content": "完成"},
                "action": {"type": "write_diary", "message": "完成", "payload": {}},
            },
            {
                "event": {
                    "type": "scheduled",
                    "source": "monos",
                    "reason": "timer_due",
                    "occurred_at": "2026-07-14T06:00:00+08:00",
                    "event_id": "selfawakeevent_test",
                }
            },
        )

        self.assertEqual(captured["payload"]["event_type"], "scheduled")
        self.assertEqual(captured["payload"]["event_source"], "monos")
        self.assertEqual(captured["payload"]["event_reason"], "timer_due")
        self.assertEqual(captured["payload"]["event_id"], "selfawakeevent_test")
        self.assertEqual(captured["payload"]["event_occurred_at"], "2026-07-14T06:00:00+08:00")

    def test_persist_self_awake_pending_uses_async_run_as_stable_id(self):
        client = CoreClient("http://core.test")
        captured = {}

        def capture_request(path, token, method="GET", payload=None):
            captured.update({"path": path, "token": token, "method": method, "payload": payload})
            return {"id": 11}

        client._request = capture_request
        client.persist_self_awake_pending(
            "token-1",
            {
                "event": {
                    "type": "scheduled",
                    "source": "monos",
                    "reason": "timer_due",
                    "event_id": "event-1",
                    "occurred_at": "2026-07-14T06:00:00+08:00",
                }
            },
            "job-1",
        )

        self.assertEqual(captured["payload"]["external_run_id"], "job-1")
        self.assertEqual(captured["payload"]["status"], "pending")
        self.assertEqual(captured["payload"]["event_id"], "event-1")

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

    def test_memo_due_prompt_uses_precise_context_without_duplicate_lookup(self):
        prompt = build_self_awake_task_prompt(
            {
                "trigger": "memo_due",
                "due_memos_checked": True,
                "event": {"type": "scheduled", "source": "monos", "reason": "memo_due"},
                "memo": {"id": 12, "title": "检查服务器", "content": "确认服务状态"},
                "due_memos": [{"id": 12, "title": "检查服务器", "content": "确认服务状态"}],
            }
        )

        self.assertIn("memo_due 精准唤醒", prompt)
        self.assertIn("不要再调用 list_due_memos", prompt)
        self.assertIn("由运行时统一处理", prompt)
        self.assertIn("检查服务器", prompt)

    def test_memo_event_preserves_subject_identity(self):
        event = normalize_self_awake_event(
            {
                "event": {
                    "type": "scheduled",
                    "source": "monos",
                    "reason": "memo_due",
                    "subject_type": "memo",
                    "subject_id": 12,
                    "scheduler_reason": "timer_due",
                }
            },
            "2026-07-16T18:30:00+08:00",
        )

        self.assertEqual(event["reason"], "memo_due")
        self.assertEqual(event["subject_type"], "memo")
        self.assertEqual(event["subject_id"], "12")

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
        )

        self.assertIn("视觉偏好：static", prompt)
        self.assertIn("可用视觉动作", prompt)
        self.assertNotIn("视觉动作组", prompt)
        self.assertNotIn("当前前端显示动作", prompt)
        self.assertIn("只有期望动作、表情或动效与当前角色状态不同时", prompt)
        self.assertIn("立绘动作、表情符号、立绘动效", prompt)
        self.assertIn("生气、叹气、无语、低落、困倦", prompt)

    def test_skill_aware_user_chat_prompt_keeps_model_action_choice_and_recent_history(self):
        prompt = build_agent_system_prompt(
            {
                "character": {
                    "name": "伊芙",
                    "visual_actions": [
                        {"name": "单手抚胸陈述", "intent": "talk", "description": "正式说明时使用。"},
                        {"name": "抬手强调", "intent": "talk", "description": "强调重点时使用。"},
                    ],
                }
            },
            source="user_chat",
            current_character_action={"action": {"name": "单手抚胸陈述", "intent": "talk"}},
            recent_character_actions=[
                {"actionName": "单手抚胸陈述"},
                {"actionName": "单手抚胸陈述"},
                {"actionName": "抬手强调"},
            ],
            active_skill_ids=(),
            skill_resource_prompt="技能目录",
        )

        self.assertIn("单手抚胸陈述 → 单手抚胸陈述 → 抬手强调", prompt)
        self.assertIn("从已提供的动作名称中选择", prompt)

    def test_user_chat_prompt_keeps_every_visual_action_without_api_payload_noise(self):
        actions = [
            {
                "id": index,
                "character_id": 8,
                "name": f"动作{index}",
                "intent": f"intent_{index}",
                "description": f"第{index}个动作的适用场景。",
                "aliases": [f"动作{index}", f"别名{index}"],
                "static_image": f"http://127.0.0.1:40011/media/actions/{index}.png",
                "static_image_url": f"http://127.0.0.1:40011/media/actions/{index}.png",
                "metadata": {"source_path": f"/private/import/action-{index}.png"},
                "dynamic_frames": [],
                "created_at": "2026-07-13T22:00:00+08:00",
                "updated_at": "2026-07-13T22:00:00+08:00",
                "enabled": True,
            }
            for index in range(1, 14)
        ]

        prompt = build_agent_system_prompt(
            {"character": {"name": "江梦晚", "visual_actions": actions}},
            source="user_chat",
        )

        for index in range(1, 14):
            self.assertIn(f"- 动作{index}｜语义=intent_{index}", prompt)
        self.assertNotIn("static_image", prompt)
        self.assertNotIn("127.0.0.1:40011/media", prompt)
        self.assertNotIn("source_path", prompt)
        self.assertNotIn("created_at", prompt)
        self.assertNotIn("已截断", prompt)
        self.assertNotIn("当前动作图片", prompt)

    def test_user_chat_task_prompt_preserves_original_text(self):
        prompt = build_user_chat_task_prompt("你好")

        self.assertEqual(prompt, "你好")

    def test_self_awake_prompt_uses_value_based_notification(self):
        prompt = build_self_awake_task_prompt({"trigger": "test"})

        self.assertIn("只有出现到期提醒、明确风险、用户期待的回访或值得关注的新进展时才调用 notify_user", prompt)
        self.assertIn("没有新信息时保持安静并记录日记", prompt)
        self.assertIn("每轮最多通知一次", prompt)
        self.assertIn("priority=normal", prompt)
        self.assertIn("priority=high", prompt)
        self.assertIn("user_activity 是桌面端上报的原始事实快照，不是行为判断", prompt)

    def test_agent_system_prompt_does_not_repeat_runtime_environment(self):
        prompt = build_agent_system_prompt({"character": {"name": "江梦晚"}})

        self.assertNotIn("# 当前环境感知", prompt)
        self.assertNotIn("Linux Mint", prompt)

    def test_start_self_awake_run_async_returns_accepted_without_running_inline(self):
        with patch("mon_agent_server.self_awake.threading.Thread") as thread_cls:
            accepted = start_self_awake_run_async({"context": {"trigger": "test"}}, FakeApp(), "token-1")

        self.assertTrue(accepted["accepted"])
        self.assertEqual(accepted["status"], "queued")
        self.assertTrue(str(accepted["async_run_id"]).startswith("selfawakejob_"))
        thread_cls.assert_called_once()
        thread_cls.return_value.start.assert_called_once()

    def test_start_self_awake_run_async_deduplicates_same_v1_job(self):
        request = {
            "schema_version": "self-awake.v1",
            "job_id": "job-dedup-test",
            "event_id": "event-dedup-test",
            "idempotency_key": "key-dedup-test",
            "context": {"event": {"source": "monos", "event_id": "event-dedup-test"}},
        }
        with patch("mon_agent_server.self_awake.threading.Thread") as thread_cls:
            first = start_self_awake_run_async(request, FakeApp(), "token-1")
            second = start_self_awake_run_async(request, FakeApp(), "token-1")

        self.assertTrue(first["accepted"])
        self.assertTrue(second["deduplicated"])
        self.assertEqual(first["async_run_id"], second["async_run_id"])
        thread_cls.assert_called_once()

    def test_async_self_awake_enrichment_failure_does_not_poison_job_cache(self):
        request = {
            "schema_version": "self-awake.v1",
            "job_id": "job-enrichment-retry-test",
            "event_id": "event-enrichment-retry-test",
            "idempotency_key": "key-enrichment-retry-test",
            "context": {"event": {"source": "monos", "event_id": "event-enrichment-retry-test"}},
        }
        from mon_agent_server.self_awake import runner

        with runner._SELF_AWAKE_JOBS_LOCK:
            runner._SELF_AWAKE_JOBS.pop(request["job_id"], None)
        try:
            with patch(
                "mon_agent_server.self_awake.runner.enrich_self_awake_request",
                side_effect=[RuntimeError("enrichment failed"), request],
            ), patch("mon_agent_server.self_awake.threading.Thread") as thread_cls:
                with self.assertRaisesRegex(RuntimeError, "enrichment failed"):
                    start_self_awake_run_async(request, FakeApp(), "token-1")

                accepted = start_self_awake_run_async(request, FakeApp(), "token-1")

            self.assertTrue(accepted["accepted"])
            self.assertFalse(accepted.get("deduplicated", False))
            thread_cls.assert_called_once()
        finally:
            with runner._SELF_AWAKE_JOBS_LOCK:
                runner._SELF_AWAKE_JOBS.pop(request["job_id"], None)

    def test_async_self_awake_worker_reaches_persistence_without_recursive_wrapper(self):
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
        app.core_client = FakeCoreClient()

        with (
            patch("mon_agent_server.self_awake.threading.Thread", InlineThread),
            patch("mon_agent_server.self_awake.run_self_awake_sync", return_value=decision),
        ):
            accepted = start_self_awake_run_async({"context": {"trigger": "test"}}, app, "token-1")

        self.assertTrue(accepted["accepted"])
        self.assertEqual(len(app.core_client.persisted), 1)

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
        ):
            result = run_self_awake_and_persist_sync({"context": {"trigger": "test"}}, app, "token-1", "job-1")

        self.assertFalse(result["accepted"])
        self.assertEqual(result["server_run_id"], 123)
        self.assertEqual(result["server_error"], "")
        self.assertEqual(result["async_run_id"], "job-1")
        self.assertEqual(app.core_client.persisted[-1][0], "token-1")
        self.assertEqual(app.core_client.persisted[-1][3], "job-1")

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
        ):
            run_self_awake_and_persist_sync({"context": {"trigger": "test"}}, app, "token-1", "job-1")

        persisted_context = app.core_client.persisted[-1][2]
        self.assertEqual(persisted_context["event"]["type"], "scheduled")
        self.assertEqual(persisted_context["event"]["source"], "monagent")
        self.assertTrue(persisted_context["event"]["event_id"].startswith("selfawakeevent_"))
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
                ["list_due_memos", "notify_user"],
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
    async def test_memo_due_permission_hook_forces_exact_notification_arguments(self):
        context = {
            "event": {"type": "scheduled", "source": "monos", "reason": "memo_due"},
            "due_memos": [
                {
                    "id": 12,
                    "title": "检查服务器",
                    "content": "确认服务状态",
                    "priority": "normal",
                }
            ],
        }
        args = {"title": "普通自醒", "message": "系统一切正常"}
        hook = self_awake_before_tool_call(context)

        result = await hook({"toolCall": {"name": "notify_user"}, "args": args})

        self.assertIsNone(result)
        self.assertEqual(args["title"], "提醒：检查服务器")
        self.assertIn("确认服务状态", args["message"])
        self.assertEqual(args["source_type"], "memo")
        self.assertEqual(args["source_id"], "12")

    async def test_memo_due_permission_hook_reserves_state_finalization_for_runtime(self):
        hook = self_awake_before_tool_call(
            {
                "event": {"type": "scheduled", "source": "monos", "reason": "memo_due"},
                "due_memos": [{"id": 12, "title": "检查服务器"}],
            }
        )

        blocked = await hook(
            {"toolCall": {"name": "mark_memo_triggered"}, "args": {"id": 12}}
        )
        dispatch_args = {"mark_dispatched": True}
        dispatch_result = await hook(
            {"toolCall": {"name": "dispatch_due_memos"}, "args": dispatch_args}
        )

        self.assertTrue(blocked["block"])
        self.assertIn("通知真实成功后", blocked["reason"])
        self.assertIsNone(dispatch_result)
        self.assertFalse(dispatch_args["mark_dispatched"])

    async def test_memo_due_runtime_notification_names_task_and_finalizes_it(self):
        core = FakeCoreClient()
        app = SimpleNamespace(config=FakeConfig(), core_client=core)
        context = {
            "event": {"type": "scheduled", "source": "monos", "reason": "memo_due"},
            "due_memos": [
                {
                    "id": 12,
                    "title": "检查服务器",
                    "content": "确认重启后是否正常",
                    "kind": "reminder",
                    "status": "active",
                    "priority": "high",
                    "repeat_rule": "",
                }
            ],
        }
        decision = {
            "should_interrupt_user": False,
            "action": {"message": "普通自醒"},
            "next_wake": {},
            "diary": {},
            "observations": [],
        }

        payload = self_awake_notification_payload(decision, context)
        self.assertEqual(payload["title"], "提醒：检查服务器")
        self.assertIn("确认重启后是否正常", payload["message"])
        self.assertEqual(payload["priority"], "high")
        self.assertEqual(payload["source_type"], "memo")
        self.assertEqual([item["id"] for item in memo_due_items(context)], [12])

        with patch("mon_agent_server.self_awake.runner.submit_memo_schedule_refresh") as refresh:
            finalized = await finalize_memo_due_notification(
                app,
                "token-1",
                context,
                {"succeeded": True},
            )

        self.assertEqual(core.marked_memos, [("token-1", 12)])
        self.assertEqual(core.completed_memos, [("token-1", 12)])
        self.assertEqual(finalized["completed"], [{"id": 12, "auto_completed": True}])
        refresh.assert_called_once()

    async def test_duplicate_block_does_not_overwrite_successful_notification(self):
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
            patch("mon_agent_server.self_awake.Agent", DuplicateNotifyAgent),
            patch("mon_agent_server.self_awake.create_mon_agent_tools", return_value=[]),
        ):
            result = await run_self_awake_agent({"context": {"trigger": "test"}}, FakeApp(), "token-1", runtime_config)

        self.assertTrue(result["notification"]["attempted"])
        self.assertTrue(result["notification"]["succeeded"])
        self.assertEqual(result["notification"]["error"], "")

    async def test_runtime_keeps_quiet_when_agent_decides_to_only_write_diary(self):
        decision = {
            "mood": "平静",
            "current_desire": "继续观察",
            "observations": ["没有到期提醒"],
            "should_interrupt_user": False,
            "action": {"type": "write_diary", "message": "完成普通自醒检查", "payload": {}},
            "next_wake": {"after_minutes": 60, "reason": "稍后再看"},
            "diary": {"title": "普通自醒", "content": "完成"},
        }
        notify_tool = FakeNotifyTool()

        with patch("mon_agent_server.self_awake.runner.create_mon_agent_tools", return_value=[notify_tool]):
            notification = await ensure_self_awake_notification(FakeApp(), "token-1", {}, decision)

        self.assertFalse(notification["attempted"])
        self.assertFalse(notification["succeeded"])
        self.assertEqual(notification["source"], "quiet_decision")
        self.assertEqual(notify_tool.calls, [])

    async def test_runtime_enforces_important_email_notification(self):
        decision = {
            "mood": "警觉",
            "current_desire": "立即告知用户",
            "observations": ["发现数据风险"],
            "should_interrupt_user": True,
            "action": {"type": "remind_user", "message": "发现重要风险", "payload": {}},
            "next_wake": {"after_minutes": 15, "reason": "继续检查"},
            "diary": {"title": "重要自醒", "content": "发现风险"},
        }
        notify_tool = FakeNotifyTool()

        with patch("mon_agent_server.self_awake.runner.create_mon_agent_tools", return_value=[notify_tool]):
            notification = await ensure_self_awake_notification(FakeApp(), "token-1", {}, decision)

        self.assertTrue(notification["succeeded"])
        self.assertEqual(notification["delivered_channels"], ["email"])
        self.assertEqual(notify_tool.calls[0][1]["priority"], "high")

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
