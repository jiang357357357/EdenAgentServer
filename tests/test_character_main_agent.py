from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from mon_agent_core import AssistantMessageEventStream

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
        self.assertNotIn("spawn_agent", captured["tools"])
        self.assertIn("冷静、克制", captured["systemPrompt"])
        self.assertIn("web-research", captured["systemPrompt"])
        self.assertIn("multi-agent", captured["systemPrompt"])
        self.assertNotIn("角色回复子智能体", captured["systemPrompt"])
        self.assertFalse(any(event["type"].startswith("subagent.") for event in events.events))
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
                environment=None,
                skill_owner_key=None,
            )

        self.assertEqual(reply, "已经可以开始网页研究。")
        self.assertNotIn("web_search", observed_tools[0])
        self.assertIn("web_search", observed_tools[1])
        self.assertIn("web_fetch", observed_tools[1])
        self.assertNotIn("当前已加载技能", observed_prompts[0])
        self.assertIn("当前已加载技能", observed_prompts[1])
        self.assertIn('<skill name="web-research"', observed_prompts[1])
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
