from __future__ import annotations

import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from tempfile import TemporaryDirectory

from mon_agent_server.runtime.manager import MonAgentRuntime
from mon_agent_server.runtime.config import DelegationPolicy, RuntimeModelConfig
from mon_agent_server.runtime.state import RunState
from mon_agent_server.runtime.subagents import (
    SubagentBudget,
    SubagentDefinition,
    SubagentToolPolicy,
    load_subagent_catalog,
)
from mon_agent_server.skills import create_skill_runtime
from mon_agent_server.store import SessionStore
from mon_agent_server.tools import MonToolContext
from mon_agent_server.tools.subagents import create_subagent_tools


class EventRecorder:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def emit(self, event: dict) -> None:
        self.events.append(event)


class SubagentCatalogTest(unittest.TestCase):
    def test_delegation_policy_defaults_to_auto_and_rejects_invalid_mode(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(DelegationPolicy.from_environment().mode, "auto")
        with patch.dict("os.environ", {"MON_AGENT_DELEGATION_MODE": "explicit"}, clear=True):
            self.assertEqual(DelegationPolicy.from_environment().mode, "explicit")
        with patch.dict("os.environ", {"MON_AGENT_DELEGATION_MODE": "unexpected"}, clear=True):
            self.assertEqual(DelegationPolicy.from_environment().mode, "auto")

    def test_project_definition_overrides_user_and_builtin_definitions(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            user_dir = root / "user-agents"
            project_dir = root / ".monagent" / "agents"
            user_dir.mkdir(parents=True)
            project_dir.mkdir(parents=True)
            (user_dir / "reviewer.toml").write_text(
                """
name = "reviewer"
description = "用户级审查"
developer_instructions = "只进行用户级审查。"
sandbox_mode = "read-only"
""".strip(),
                encoding="utf-8",
            )
            (project_dir / "reviewer.toml").write_text(
                """
name = "reviewer"
description = "项目级审查"
developer_instructions = "遵循当前项目的审查约束。"
sandbox_mode = "read-only"
skills = ["web-research"]
thinking_level = "high"
[budget]
max_turns = 12
max_tool_calls = 24
timeout_seconds = 300
""".strip(),
                encoding="utf-8",
            )
            (project_dir / "planner.toml").write_text(
                """
name = "planner"
description = "任务规划"
developer_instructions = "只输出可执行计划。"
sandbox_mode = "read-only"
""".strip(),
                encoding="utf-8",
            )

            catalog = load_subagent_catalog(root, user_agent_dir=user_dir)

            reviewer = catalog.resolve("reviewer")
            self.assertEqual(reviewer.description, "项目级审查")
            self.assertEqual(reviewer.source, "project")
            self.assertEqual(reviewer.skills, ("web-research",))
            self.assertEqual(reviewer.thinking_level, "high")
            self.assertEqual(reviewer.budget, SubagentBudget(12, 24, 300))
            self.assertIn("planner", catalog.names)
            self.assertIn("coder", catalog.names)
            self.assertIn("explore", catalog.names)
            self.assertIn("file_locator", catalog.names)
            self.assertEqual(catalog.resolve("file_locator").sandbox_mode, "read-only")

    def test_invalid_definition_reports_its_file(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            project_dir = root / ".monagent" / "agents"
            project_dir.mkdir(parents=True)
            path = project_dir / "invalid.toml"
            path.write_text('name = "Invalid Name"', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "invalid.toml"):
                load_subagent_catalog(root, user_agent_dir=root / "empty")

    def test_invalid_budget_reports_its_file(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            project_dir = root / ".monagent" / "agents"
            project_dir.mkdir(parents=True)
            path = project_dir / "invalid-budget.toml"
            path.write_text(
                """
name = "limited"
description = "受限任务"
developer_instructions = "执行任务。"
[budget]
max_turns = 0
""".strip(),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "invalid-budget.toml"):
                load_subagent_catalog(root, user_agent_dir=root / "empty")

    def test_nested_budget_can_only_be_narrowed(self) -> None:
        parent = SubagentBudget(max_turns=10, max_tool_calls=20, timeout_seconds=300)
        child = SubagentBudget(max_turns=50, max_tool_calls=5, timeout_seconds=600)

        self.assertEqual(parent.restrict(child), SubagentBudget(10, 5, 300))


class SubagentToolPolicyTest(unittest.IsolatedAsyncioTestCase):
    async def test_definition_can_select_a_core_ai_entity_and_reasoning_level(self) -> None:
        class Core:
            def get_ai_entity(self, token, entity_id):
                self.args = (token, entity_id)
                return {
                    "id": entity_id,
                    "vendor": "openai",
                    "ai_name": "Background model",
                    "ai_model": "background-test",
                    "api_key": "secret",
                    "api_endpoint": "https://example.test/v1",
                    "is_multimodal": False,
                }

        core = Core()
        host = object.__new__(MonAgentRuntime)
        host.core_client = core
        parent = RuntimeModelConfig(
            {"id": "parent", "input": ["text"]},
            "parent-key",
            "openai/parent",
            "core",
            {"assistant": {}, "character": {}, "aiEntity": {}},
        )
        definition = SubagentDefinition(
            name="planner",
            description="规划",
            developer_instructions="规划任务。",
            ai_entity_id=9,
            thinking_level="high",
        )

        resolved = await host._resolve_subagent_runtime_config(definition, parent, "core-token")

        self.assertEqual(core.args, ("core-token", 9))
        self.assertEqual(resolved.label, "openai/background-test")
        self.assertEqual(resolved.api_key, "secret")
        self.assertEqual(resolved.thinking_level, "high")

    async def test_read_only_policy_filters_loaded_skills_and_blocks_execution(self) -> None:
        policy = SubagentToolPolicy.create("read-only")
        runtime = create_skill_runtime(
            Path.cwd(),
            profile="user_chat",
            active_skill_ids=("workspace-development", "multi-agent"),
            tool_filter=policy.filter(),
        )
        names = {tool.name for tool in runtime.active_tools()}

        self.assertIn("read", names)
        self.assertIn("external_find", names)
        self.assertIn("search_memories", names)
        self.assertIn("spawn_agent", names)
        self.assertNotIn("write", names)
        self.assertNotIn("edit", names)
        self.assertNotIn("bash", names)

        runtime.load(["memo-management"])
        self.assertNotIn("create_memo", {tool.name for tool in runtime.active_tools()})
        self.assertNotIn("remember_memory", names)
        self.assertNotIn("update_memory", names)
        self.assertNotIn("forget_memory", names)

        host = object.__new__(MonAgentRuntime)
        hook = host._before_tool_call(
            "session-test",
            RunState(),
            agent_path="/root/reviewer",
            tool_policy=policy,
        )
        blocked = await hook(
            {"toolCall": {"id": "call-1", "name": "write"}, "args": {"path": "x"}},
        )
        self.assertTrue(blocked["block"])
        self.assertIn("read-only", blocked["reason"])

    def test_nested_policy_cannot_expand_parent_permissions(self) -> None:
        parent = SubagentToolPolicy.create("read-only")
        child = SubagentToolPolicy.create("workspace-write")

        effective = parent.restrict(child)

        self.assertEqual(effective.sandbox_mode, "read-only")
        self.assertTrue(effective.allows("read"))
        self.assertFalse(effective.allows("write"))
        self.assertFalse(effective.allows("bash"))

    def test_all_subagent_modes_deny_every_sticker_tool(self) -> None:
        sticker_tools = {
            "list_character_stickers",
            "remember_character_sticker",
            "send_character_sticker",
            "delete_character_sticker",
        }
        for mode in ("inherit", "read-only", "workspace-write"):
            policy = SubagentToolPolicy.create(mode, allowed_tools=tuple(sticker_tools))
            self.assertTrue(sticker_tools.isdisjoint(
                {name for name in sticker_tools if policy.allows(name)}
            ))

        restored = SubagentToolPolicy.from_payload({
            "sandboxMode": "inherit",
            "allowedTools": None,
            "deniedTools": [],
        })
        self.assertTrue(all(not restored.allows(name) for name in sticker_tools))

    def test_spawn_schema_uses_runtime_catalog_names(self) -> None:
        tools = create_subagent_tools(
            MonToolContext(subagent_role_names=("general", "planner", "reviewer"))
        )
        self.assertNotIn("wait_agent", {tool.name for tool in tools})
        spawn = next(tool for tool in tools if tool.name == "spawn_agent")

        self.assertEqual(
            spawn.parameters["properties"]["role"]["enum"],
            ["general", "planner", "reviewer"],
        )
        self.assertIn("background", spawn.parameters["properties"])
        self.assertIn("required_for_final", spawn.parameters["properties"])
        self.assertTrue(spawn.parameters["properties"]["required_for_final"]["default"])
        self.assertIn("task_category", spawn.parameters["properties"])
        self.assertIn("target_scope", spawn.parameters["properties"])
        self.assertIn("code_exploration", spawn.parameters["properties"]["task_category"]["enum"])
        self.assertIn("边界清晰、可独立完成", spawn.description)
        self.assertIn("planner", spawn.description)
        self.assertIn("reviewer", spawn.description)
        self.assertIn("user_file_location", spawn.parameters["properties"]["task_category"]["enum"])
        self.assertIn("user_files", spawn.parameters["properties"]["target_scope"]["properties"]["kind"]["enum"])

    async def test_delegation_mode_does_not_block_root_search_tools(self) -> None:
        runtime = MonAgentRuntime(Path.cwd(), SessionStore(), EventRecorder(), None, None, object())
        runtime.permissions = Mock()
        runtime.permissions.is_always_allowed.return_value = True
        hook = runtime._before_tool_call("ses_soft_delegation", RunState(), delegation_mode="proactive")

        calls = (
            {"toolCall": {"name": "web"}, "args": {"action": "search", "query": "AI 行业最新资讯", "max_results": 10}},
            {"toolCall": {"name": "find"}, "args": {"path": "/home", "pattern": "*save*", "max_depth": 8}},
            {"toolCall": {"name": "bash"}, "args": {"command": 'find /home/manager -iname "*galgame*"'}},
        )

        for call in calls:
            self.assertIsNone(await hook(call))
        self.assertFalse(any(event["type"].startswith("delegation.") for event in runtime.events.events))
        runtime.close()


if __name__ == "__main__":
    unittest.main()
