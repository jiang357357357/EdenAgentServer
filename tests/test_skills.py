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
    def test_catalog_contains_the_bounded_skills(self) -> None:
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
                "multi-agent",
                "assistant-switching",
            },
        )

    def test_user_chat_exposes_stable_profile_tools(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")
        names = _tool_names(runtime.active_tools())

        self.assertNotIn("loaded_tools", names)
        for name in {
            "load_skill", "read", "write", "edit", "apply_patch", "bash", "write_stdin",
            "web_search", "create_memo", "analyze_screen", "send_qq_message",
            "switch_session_assistant", "remember_memory", "spawn_agent",
        }:
            self.assertIn(name, names)

    def test_loading_updates_prompt_but_not_tools_for_next_model_call(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")
        initial_tools = runtime.active_tools()

        result = runtime.load(["memo-management"])
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
        self.assertIn("web_search", names)
        self.assertIn("write", names)
        self.assertEqual(names, _tool_names(initial_tools))
        self.assertEqual(context["systemPrompt"], "active=memo-management")
        self.assertIsNone(runtime.prepare_next_turn({"context": context}, lambda _ids: "unused"))

    def test_workspace_development_exposes_apply_patch(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")

        result = runtime.load(["workspace-development"])

        self.assertTrue(result["success"])
        self.assertIn("apply_patch", _tool_names(runtime.active_tools()))
        prompt = runtime.prompt_section()
        self.assertIn("修改代码、构建、测试", prompt)
        self.assertNotIn("绕过 file_locator", prompt)

    def test_visual_observation_loads_instructions_without_changing_tools(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")

        before = _tool_names(runtime.active_tools())
        self.assertIn("capture_camera", before)
        result = runtime.load(["visual-observation"])

        self.assertTrue(result["success"])
        names = _tool_names(runtime.active_tools())
        self.assertIn("analyze_image", names)
        self.assertIn("analyze_screen", names)
        self.assertIn("capture_camera", names)
        self.assertEqual(names, before)
        self.assertIn("只拍摄完成当前请求所需的一帧", runtime.prompt_section())

    def test_assistant_switching_loads_instructions_without_changing_tools(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")

        before = _tool_names(runtime.active_tools())
        self.assertIn("switch_session_assistant", before)
        result = runtime.load(["assistant-switching"])

        self.assertTrue(result["success"])
        names = _tool_names(runtime.active_tools())
        self.assertIn("list_assistants", names)
        self.assertIn("switch_session_assistant", names)
        self.assertEqual(names, before)
        self.assertIn("会话历史会保留", runtime.prompt_section())
        self.assertIn("无需由原助手告别或转交", runtime.prompt_section())

    def test_multi_agent_skill_adds_policy_without_gating_control_tools(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")

        self.assertIn("spawn_agent", _tool_names(runtime.active_tools()))
        result = runtime.load(["multi-agent"])

        self.assertTrue(result["success"])
        names = _tool_names(runtime.active_tools())
        self.assertIn("spawn_agent", names)
        self.assertNotIn("wait_agent", names)
        self.assertIn("interrupt_agent", names)
        self.assertIn("可独立完成的任务可交给子智能体", runtime.prompt_section())
        self.assertIn("验证、整合和表达", runtime.prompt_section())

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
        self.assertIn("web_search", names)

        result = runtime.load(["web-research"])
        self.assertTrue(result["success"])
        self.assertIn("web_search", _tool_names(runtime.active_tools()))

    def test_skill_aware_prompt_lists_catalog_and_active_instructions(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")
        initial = build_agent_tool_section(
            "user_chat",
            True,
            runtime.loaded_skill_ids,
            runtime.prompt_section(),
        )
        runtime.load(["memo-management"])
        active = build_agent_tool_section(
            "user_chat",
            True,
            runtime.loaded_skill_ids,
            runtime.prompt_section(),
        )

        self.assertIn("load_skill", initial)
        self.assertIn("<available_skills>", initial)
        self.assertIn("memo-management", initial)
        self.assertIn("workspace-development", initial)
        self.assertIn("工作区外使用对应的 external 工具", initial)
        self.assertIn("当前已加载技能", active)
        self.assertIn("create_reminder", active)

    def test_explicit_skill_command_preloads_skill_and_preserves_arguments(self) -> None:
        runtime = create_skill_runtime(Path.cwd(), profile="user_chat")

        result = runtime.load_command("/skill:web-research 查一下今天的新闻")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result["success"])
        self.assertEqual(result["loaded"], ["web-research"])
        self.assertEqual(result["userMessage"], "查一下今天的新闻")
        self.assertIn("web_search", _tool_names(runtime.active_tools()))


class SkillActivationLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_tools_remain_available_when_skill_runtime_is_recreated_next_turn(self) -> None:
        first_turn = create_skill_runtime(Path.cwd(), profile="user_chat")
        loader = next(tool for tool in first_turn.active_tools() if tool.name == "load_skill")

        result = await loader.execute(
            "load-workspace",
            {"skills": ["workspace-development"]},
        )
        second_turn = create_skill_runtime(Path.cwd(), profile="user_chat")

        self.assertIn("已加载技能：workspace-development", result["content"][0]["text"])
        self.assertNotIn("已启用这些技能对应的工具", result["content"][0]["text"])
        self.assertEqual(second_turn.loaded_skill_ids, ())
        self.assertIn("write", _tool_names(second_turn.active_tools()))
        self.assertIn("bash", _tool_names(second_turn.active_tools()))
        self.assertIn("write_stdin", _tool_names(second_turn.active_tools()))

    async def test_loading_skill_changes_instructions_not_available_tools(self) -> None:
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
                                "name": "load_skill",
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
        self.assertIn("create_reminder", observed_tools[0])
        self.assertIn("create_reminder", observed_tools[1])
        self.assertIn("create_memo", observed_tools[1])
        self.assertEqual(observed_tools[0], observed_tools[1])
        self.assertEqual(
            [message["role"] for message in agent.state.messages],
            ["user", "assistant", "toolResult", "assistant"],
        )


if __name__ == "__main__":
    unittest.main()
