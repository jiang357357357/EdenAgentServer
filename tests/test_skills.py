from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

from mon_agent_core import Agent, AgentOptions, AssistantMessageEventStream

from mon_agent_server.prompts.builder import build_agent_tool_section
from mon_agent_server.skills import SKILL_DEFINITIONS, create_skill_runtime


def _model() -> dict[str, Any]:
    return {
        "id": "fake-model",
        "name": "Fake Model",
        "api": "fake",
        "provider": "fake",
    }


def _done_stream(message: dict[str, Any]) -> AssistantMessageEventStream:
    stream = AssistantMessageEventStream()
    stream.push({"type": "start", "partial": {**message, "content": []}})
    stream.push({"type": "done", "message": message})
    return stream


def _tool_names(tools: list[Any]) -> set[str]:
    return {tool.name for tool in tools}


class SkillCatalogTest(unittest.TestCase):
    def test_catalog_contains_the_nine_bounded_skills(self) -> None:
        self.assertEqual(
            {skill.id for skill in SKILL_DEFINITIONS},
            {
                "memo-management",
                "due-reminder-dispatch",
                "self-awake",
                "web-research",
                "daily-context",
                "visual-observation",
                "qq-communication",
                "email-communication",
                "workspace-development",
            },
        )

    def test_user_chat_starts_with_only_core_tools(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")
        names = _tool_names(runtime.active_tools())

        self.assertEqual(
            names,
            {
                "activate_skill",
                "ask_user",
                "list_character_actions",
                "switch_character_action",
                "read",
                "ls",
                "grep",
                "find",
            },
        )
        self.assertNotIn("loaded_tools", names)
        self.assertNotIn("create_memo", names)
        self.assertNotIn("web_search", names)
        self.assertNotIn("write", names)

    def test_activation_updates_tools_and_prompt_for_next_model_call(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")
        initial_tools = runtime.active_tools()

        result = runtime.activate(["memo-management"])
        update = runtime.prepare_next_turn(
            {
                "context": {
                    "systemPrompt": "initial",
                    "messages": [],
                    "tools": initial_tools,
                }
            },
            lambda active_ids: f"active={','.join(active_ids)}",
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["activated"], ["memo-management"])
        self.assertIsNotNone(update)
        assert update is not None
        context = update["context"]
        names = _tool_names(context["tools"])
        self.assertIn("create_memo", names)
        self.assertIn("create_reminder", names)
        self.assertIn("list_memos", names)
        self.assertNotIn("web_search", names)
        self.assertNotIn("write", names)
        self.assertEqual(context["systemPrompt"], "active=memo-management")
        self.assertIsNone(runtime.prepare_next_turn({"context": context}, lambda _ids: "unused"))

    def test_workspace_development_exposes_apply_patch(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")

        result = runtime.activate(["workspace-development"])

        self.assertTrue(result["success"])
        self.assertIn("apply_patch", _tool_names(runtime.active_tools()))

    def test_self_awake_has_system_skills_but_not_user_mutation_tools(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="self_awake")
        names = _tool_names(runtime.active_tools())

        self.assertIn("list_due_memos", names)
        self.assertIn("notify_user", names)
        self.assertIn("mark_memo_triggered", names)
        self.assertIn("get_self_awake_state", names)
        self.assertNotIn("ask_user", names)
        self.assertNotIn("write", names)
        self.assertNotIn("send_qq_message", names)
        self.assertNotIn("send_external_email", names)
        self.assertNotIn("web_search", names)

        result = runtime.activate(["web-research"])
        self.assertTrue(result["success"])
        self.assertIn("web_search", _tool_names(runtime.active_tools()))

    def test_skill_aware_prompt_lists_catalog_and_active_instructions(self) -> None:
        initial = build_agent_tool_section("user_chat", True, ())
        active = build_agent_tool_section("user_chat", True, ("memo-management",))

        self.assertIn("activate_skill", initial)
        self.assertIn("memo-management", initial)
        self.assertIn("workspace-development", initial)
        self.assertIn("当前已激活技能说明", active)
        self.assertIn("create_reminder", active)


class SkillActivationLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_activated_tools_are_available_in_the_same_agent_run(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")
        observed_tools: list[set[str]] = []

        async def stream_fn(
            _model_value: dict[str, Any],
            context: dict[str, Any],
            _options: dict[str, Any],
        ) -> AssistantMessageEventStream:
            observed_tools.append(_tool_names(context["tools"]))
            if len(observed_tools) == 1:
                return _done_stream(
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "activate-1",
                                "name": "activate_skill",
                                "arguments": {"skills": ["memo-management"]},
                            }
                        ],
                        "stopReason": "tool_calls",
                        "timestamp": 1,
                    }
                )
            return _done_stream(
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "ready"}],
                    "stopReason": "stop",
                    "timestamp": 2,
                }
            )

        agent = Agent(
            AgentOptions(
                initial_state={
                    "model": _model(),
                    "systemPrompt": "initial",
                    "tools": runtime.active_tools(),
                },
                stream_fn=stream_fn,
                tool_execution="sequential",
                prepare_next_turn_with_context=lambda turn, _signal: runtime.prepare_next_turn(
                    turn,
                    lambda active_ids: f"active={','.join(active_ids)}",
                ),
            )
        )

        await agent.prompt("提醒我明天开会")

        self.assertEqual(len(observed_tools), 2)
        self.assertNotIn("create_reminder", observed_tools[0])
        self.assertIn("create_reminder", observed_tools[1])
        self.assertIn("create_memo", observed_tools[1])
        self.assertEqual(
            [message["role"] for message in agent.state.messages],
            ["user", "assistant", "toolResult", "assistant"],
        )


if __name__ == "__main__":
    unittest.main()
