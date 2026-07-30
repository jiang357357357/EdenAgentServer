from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from mon_agent_core import AssistantMessageEventStream

from mon_agent_server.brokers import PermissionBroker
from mon_agent_server.llm.messages import to_openai_messages
from mon_agent_server.runtime.companion import DirectorBeat, DirectorExecution, DirectorScene
from mon_agent_server.runtime.config import RuntimeModelConfig
from mon_agent_server.runtime.manager import MonAgentRuntime
from mon_agent_server.runtime.state import RunState
from mon_agent_server.store import SessionStore


class EventRecorder:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)


def stream_message(text: str) -> AssistantMessageEventStream:
    message = {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "stopReason": "stop",
        "timestamp": 1,
    }
    stream = AssistantMessageEventStream()
    stream.push({"type": "start", "partial": {**message, "content": []}})
    stream.push({"type": "done", "message": message})
    return stream


def tool_call_message(name: str, arguments: dict[str, Any]) -> AssistantMessageEventStream:
    message = {
        "role": "assistant",
        "content": [{"type": "toolCall", "id": "tool-call-1", "name": name, "arguments": arguments}],
        "stopReason": "tool_calls",
        "timestamp": 1,
    }
    stream = AssistantMessageEventStream()
    stream.push({"type": "start", "partial": {**message, "content": []}})
    stream.push({"type": "done", "message": message})
    return stream


class CharacterMainAgentRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_assistant_switch_continues_same_tool_loop_with_new_model_and_identity(self) -> None:
        store = SessionStore()
        session = store.create_session(
            "即时接管",
            [{"assistantID": 1, "assistantName": "助手 A", "characterID": 10, "characterName": "角色 A"}],
        )
        text = "/skill:assistant-switching 切换到助手 B"
        user_message = store.append_user_message(session["id"], text, [])
        events = EventRecorder()
        permissions = PermissionBroker(events)
        permissions.hydrate_mode("full_access")

        class Core:
            def __init__(self):
                self.operations: list[tuple[str, Any, Any]] = []

            def update_agent_session_participants(self, _token, info, assistant_ids):
                self.operations.append(("participants", assistant_ids[0], None))
                return {
                    **info,
                    "participants": [
                        {
                            "assistantID": assistant_ids[0],
                            "assistantName": "助手 B",
                            "characterID": 20,
                            "characterName": "角色 B",
                        }
                    ],
                    "participantAssistantIDs": list(assistant_ids),
                }

            def list_memories(self, _token, _params):
                return []

            def sync_agent_message(self, _token, _session, message, _core):
                speaker = message["info"].get("speaker") or {}
                core_assistant = ((_core or {}).get("assistant") or {}).get("id")
                self.operations.append(("message", speaker.get("assistantID"), core_assistant))
                return message

        core = Core()
        runtime = MonAgentRuntime(Path.cwd(), store, events, permissions, None, core)
        config_a = RuntimeModelConfig(
            {"id": "model-a", "name": "A", "api": "fake", "provider": "fake", "input": ["text"]},
            "key-a",
            "A",
            "test",
            {
                "assistant": {"id": 1, "name": "助手 A"},
                "character": {"id": 10, "name": "角色 A"},
                "aiEntity": {},
            },
        )
        config_b = RuntimeModelConfig(
            {"id": "model-b", "name": "B", "api": "fake", "provider": "fake", "input": ["text"]},
            "key-b",
            "B",
            "test",
            {
                "assistant": {"id": 2, "name": "助手 B"},
                "character": {"id": 20, "name": "角色 B"},
                "aiEntity": {},
            },
        )
        observed: list[dict[str, Any]] = []

        async def fake_stream(model, context, options):
            observed.append(
                {
                    "model": model["id"],
                    "prompt": context["systemPrompt"],
                    "apiKey": options["apiKey"],
                    "messages": to_openai_messages(context),
                }
            )
            if len(observed) == 1:
                return tool_call_message("switch_session_assistant", {"assistant_id": 2})
            return stream_message("[助手 B]\n\n我是助手 B，已经接手这段对话。")

        with (
            patch.object(runtime, "_resolve_runtime_config", return_value=config_b),
            patch("mon_agent_server.runtime.manager.session_from_map", side_effect=lambda value: value),
            patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream),
        ):
            _, reply = await runtime._run_character_main_agent(
                session_id=session["id"],
                parts=[{"type": "text", "text": text}],
                user_message=user_message,
                auth_token="token",
                runtime_config=config_a,
                run_state=RunState(speaker={"assistantID": 1, "assistantName": "助手 A"}),
                beat=DirectorBeat(1, "切换助手"),
                scene=None,
                execution=None,
                previous_replies=[],
                environment=None,
                skill_owner_key=None,
            )

        self.assertEqual(reply, "我是助手 B，已经接手这段对话。")
        self.assertEqual([item["model"] for item in observed], ["model-a", "model-b"])
        self.assertEqual([item["apiKey"] for item in observed], ["key-a", "key-b"])
        self.assertIn("角色 A", observed[0]["prompt"])
        self.assertIn("角色 B", observed[1]["prompt"])
        switch_message = next(
            item
            for item in observed[1]["messages"]
            if item.get("role") == "assistant" and item.get("tool_calls")
        )
        self.assertEqual(switch_message["content"], "[助手 A]")
        self.assertEqual(
            core.operations,
            [
                ("message", 1, 1),
                ("participants", 2, None),
                ("message", 2, 2),
            ],
        )
        self.assertEqual(store.require_session(session["id"])["info"]["participantAssistantIDs"], [2])
        runtime.close()

    async def test_character_model_timeout_raises_actionable_error(self) -> None:
        store = SessionStore()
        session = store.create_session("超时测试")
        user_message = store.append_user_message(session["id"], "你好", [])
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        runtime.model_request_timeout_seconds = 0.01
        config = RuntimeModelConfig(
            {"id": "hanging", "name": "Hanging", "api": "fake", "provider": "fake", "input": ["text"]},
            None, "fake/hanging", "test", {"assistant": {}, "character": {}, "aiEntity": {}},
        )

        async def hanging_stream(_model, _context, _options):
            await asyncio.Event().wait()

        with (
            patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=hanging_stream),
            self.assertRaisesRegex(RuntimeError, "模型请求超时.*fake/hanging"),
        ):
            await runtime._run_character_main_agent(
                session_id=session["id"], parts=[{"type": "text", "text": "你好"}],
                user_message=user_message, auth_token=None, runtime_config=config,
                run_state=RunState(speaker={}), beat=DirectorBeat(1, "回应"), scene=None,
                execution=None, previous_replies=[], environment=None, skill_owner_key=None,
            )
        runtime.close()

    async def test_character_main_agent_has_identity_and_on_demand_skills(self) -> None:
        store = SessionStore()
        session = store.create_session("回复测试")
        user_message = store.append_user_message(session["id"], "你好", [])
        events = EventRecorder()
        runtime = MonAgentRuntime(Path.cwd(), store, events, None, None, object())
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            {
                "assistant": {"id": 1, "name": "伊芙"},
                "character": {"id": 2, "name": "伊芙", "description": "冷静、克制"},
                "aiEntity": {},
            },
        )
        captured: dict[str, Any] = {}

        async def fake_stream(_model, context, _options):
            captured["systemPrompt"] = context["systemPrompt"]
            captured["tools"] = [tool.name for tool in context["tools"]]
            return stream_message("您好。")

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            message, reply = await runtime._run_character_main_agent(
                session_id=session["id"],
                parts=[{"type": "text", "text": "你好"}],
                user_message=user_message,
                auth_token=None,
                runtime_config=config,
                run_state=RunState(speaker={"assistantID": 1, "assistantName": "伊芙"}),
                beat=DirectorBeat(1, "回应问候"),
                scene=None,
                execution=None,
                previous_replies=[],
                environment=None,
                skill_owner_key=None,
            )

        self.assertEqual(reply, "您好。")
        self.assertIsNotNone(message)
        self.assertIn("load_skill", captured["tools"])
        self.assertIn("read", captured["tools"])
        self.assertIn("switch_character_action", captured["tools"])
        self.assertNotIn("web_search", captured["tools"])
        self.assertIn("spawn_agent", captured["tools"])
        self.assertIn("冷静、克制", captured["systemPrompt"])
        self.assertIn("web-research", captured["systemPrompt"])
        self.assertIn("multi-agent", captured["systemPrompt"])
        self.assertIn("当前委派模式：auto", captured["systemPrompt"])
        self.assertIn("researcher", captured["systemPrompt"])
        self.assertIn("根据任务范围、不确定性、上下文成本和并行收益", captured["systemPrompt"])
        self.assertIn("负责验证、整合和最终表达", captured["systemPrompt"])
        self.assertNotIn("不要轮询或调用 wait_agent", captured["systemPrompt"])
        self.assertNotIn("角色回复子智能体", captured["systemPrompt"])
        self.assertFalse(any(event["type"].startswith("subagent.") for event in events.events))
        runtime.close()

    async def test_explicit_delegation_mode_is_reflected_in_system_prompt(self) -> None:
        store = SessionStore()
        session = store.create_session("显式委派")
        user_message = store.append_user_message(session["id"], "你好", [])
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        with patch.dict("os.environ", {"MON_AGENT_DELEGATION_MODE": "explicit"}):
            config = RuntimeModelConfig(
                {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
                None, "Fake", "test", {"assistant": {}, "character": {}, "aiEntity": {}},
            )
        captured: dict[str, str] = {}

        async def fake_stream(_model, context, _options):
            captured["prompt"] = context["systemPrompt"]
            return stream_message("完成")

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            await runtime._run_character_main_agent(
                session_id=session["id"], parts=[{"type": "text", "text": "你好"}],
                user_message=user_message, auth_token=None, runtime_config=config,
                run_state=RunState(speaker={}), beat=DirectorBeat(1, "回应"), scene=None,
                execution=None, previous_replies=[], environment=None, skill_owner_key=None,
            )

        self.assertIn("当前委派模式：explicit", captured["prompt"])
        self.assertIn("明确要求委派", captured["prompt"])
        runtime.close()

    async def test_character_loads_web_research_in_the_same_agent_run(self) -> None:
        store = SessionStore()
        session = store.create_session("按需技能测试")
        user_message = store.append_user_message(session["id"], "查询最新资料", [])
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            {
                "assistant": {"id": 1, "name": "伊芙"},
                "character": {"id": 2, "name": "伊芙"},
                "aiEntity": {},
            },
        )
        observed_tools: list[set[str]] = []
        observed_prompts: list[str] = []

        async def fake_stream(_model, context, _options):
            observed_tools.append({tool.name for tool in context["tools"]})
            observed_prompts.append(context["systemPrompt"])
            if len(observed_tools) == 1:
                return tool_call_message("load_skill", {"skills": ["web-research"]})
            return stream_message("已经可以开始网页研究。")

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            _, reply = await runtime._run_character_main_agent(
                session_id=session["id"],
                parts=[{"type": "text", "text": "查询最新资料"}],
                user_message=user_message,
                auth_token=None,
                runtime_config=config,
                run_state=RunState(speaker={"assistantID": 1, "assistantName": "伊芙"}),
                beat=DirectorBeat(1, "查询资料"),
                scene=None,
                execution=None,
                previous_replies=[],
                environment={"timezone": "Asia/Shanghai", "locale": "zh-CN"},
                skill_owner_key=None,
            )

        self.assertEqual(reply, "已经可以开始网页研究。")
        self.assertNotIn("web_search", observed_tools[0])
        self.assertIn("web_search", observed_tools[1])
        self.assertIn("web_fetch", observed_tools[1])
        self.assertNotIn("当前已加载技能", observed_prompts[0])
        self.assertIn("当前已加载技能", observed_prompts[1])
        self.assertIn('<skill name="web-research"', observed_prompts[1])
        self.assertIn("当前本地时间：", observed_prompts[0])
        self.assertIn("当前本地时间：", observed_prompts[1])
        runtime.close()

    async def test_character_compacts_during_tool_loop_and_continues_same_run(self) -> None:
        store = SessionStore()
        session = store.create_session("轮内压缩测试")
        user_message = store.append_user_message(session["id"], "先调用工具再继续", [])
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            "key", "Fake", "test", {"assistant": {}, "character": {}, "aiEntity": {}},
        )
        stream_contexts: list[list[dict[str, Any]]] = []
        compact_calls: list[list[dict[str, Any]]] = []

        async def fake_stream(_model, context, _options):
            stream_contexts.append(list(context["messages"]))
            if len(stream_contexts) == 1:
                return tool_call_message("load_skill", {"skills": ["web-research"]})
            return stream_message("压缩后继续完成。")

        async def fake_compact(_session_id, _run_state, _runtime_config, messages, *_args, **_kwargs):
            compact_calls.append(list(messages))
            if len(compact_calls) == 1:
                return messages
            return [
                {"role": "compactionSummary", "summary": "旧上下文摘要"},
                *messages[-2:],
            ]

        with (
            patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream),
            patch.object(runtime, "compact_agent_messages_if_needed", new=fake_compact),
        ):
            _, reply = await runtime._run_character_main_agent(
                session_id=session["id"], parts=[{"type": "text", "text": "先调用工具再继续"}],
                user_message=user_message, auth_token=None, runtime_config=config,
                run_state=RunState(speaker={}), beat=DirectorBeat(1, "执行"), scene=None,
                execution=None, previous_replies=[], environment=None, skill_owner_key=None,
            )

        self.assertEqual(reply, "压缩后继续完成。")
        self.assertEqual(len(compact_calls), 2)
        self.assertTrue(any(message.get("role") == "toolResult" for message in compact_calls[1]))
        self.assertIn("旧上下文摘要", str(stream_contexts[1]))
        runtime.close()

    async def test_non_tool_owner_cannot_gain_mutation_tools_from_a_skill(self) -> None:
        store = SessionStore()
        session = store.create_session("多人权限测试")
        text = "/skill:workspace-development 修改文件"
        user_message = store.append_user_message(session["id"], text, [])
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            {
                "assistant": {"id": 1, "name": "伊芙"},
                "character": {"id": 2, "name": "伊芙"},
                "aiEntity": {},
            },
        )
        captured: dict[str, Any] = {}

        async def fake_stream(_model, context, _options):
            captured["tools"] = {tool.name for tool in context["tools"]}
            return stream_message("我会把实际操作交给本轮负责人。")

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            await runtime._run_character_main_agent(
                session_id=session["id"],
                parts=[{"type": "text", "text": text}],
                user_message=user_message,
                auth_token=None,
                runtime_config=config,
                run_state=RunState(speaker={"assistantID": 1, "assistantName": "伊芙"}),
                beat=DirectorBeat(1, "协作回应"),
                scene=DirectorScene(interaction_type="task"),
                execution=DirectorExecution(
                    mode="lead_support",
                    lead_assistant_id=1,
                    tool_owner_assistant_id=2,
                ),
                previous_replies=[],
                environment=None,
                skill_owner_key=None,
            )

        self.assertNotIn("write", captured["tools"])
        self.assertNotIn("edit", captured["tools"])
        self.assertNotIn("bash", captured["tools"])
        self.assertIn("read", captured["tools"])
        self.assertIn("switch_character_action", captured["tools"])
        runtime.close()


if __name__ == "__main__":
    unittest.main()
