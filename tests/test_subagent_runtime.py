from __future__ import annotations

import unittest
import asyncio
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest.mock import Mock, patch

from mon_agent_core import AgentControl, AssistantMessageEventStream

from mon_agent_server.runtime import MonAgentRuntime
from mon_agent_server.runtime.config import RuntimeModelConfig
from mon_agent_server.runtime.subagents import SubagentBudget, SubagentCatalog, SubagentDefinition
from mon_agent_server.store import SessionStore
from mon_agent_server.store.subagent_repository import SubagentThreadRepository


class EventRecorder:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)


class SubagentRuntimeIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_abort_interrupts_all_active_subagents(self) -> None:
        permissions = Mock()
        runtime = MonAgentRuntime(
            Path.cwd(), SessionStore(), EventRecorder(), permissions, None, object()
        )
        started = threading.Event()
        cancelled = threading.Event()

        async def runner(_thread, _message):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def spawn_worker() -> AgentControl:
            control = AgentControl("session-abort")
            await control.spawn(message="等待", task_name="worker", runner=runner)
            return control

        try:
            control = runtime._host.submit(spawn_worker()).result(timeout=2)
            runtime._agent_controls["session-abort"] = control
            self.assertTrue(started.wait(timeout=2))

            self.assertTrue(runtime.abort("session-abort"))

            self.assertTrue(cancelled.wait(timeout=2))
            self.assertEqual(control.list_agents()[0].status, "interrupted")
            permissions.reject_all.assert_called_once_with(
                "session-abort", reason="session_aborted"
            )
        finally:
            runtime.close()

    async def test_runtime_limits_are_configurable_and_bounded(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "MON_AGENT_SUBAGENT_MAX_THREADS": "12",
                "MON_AGENT_SUBAGENT_MAX_CONCURRENT_PER_SESSION": "3",
                "MON_AGENT_SUBAGENT_MAX_CONCURRENT_GLOBAL": "5",
                "MON_AGENT_SUBAGENT_MAX_DEPTH": "99",
            },
        ):
            runtime = MonAgentRuntime(Path.cwd(), SessionStore(), EventRecorder(), None, None, object())

        control = runtime._agent_control_for("session-limits")
        self.assertEqual(control.max_threads, 12)
        self.assertEqual(control.max_concurrent, 3)
        self.assertEqual(runtime.subagent_max_concurrent_global, 5)
        self.assertEqual(control.max_depth, 8)

    async def test_child_result_reaches_mailbox_and_not_chat_messages(self) -> None:
        store = SessionStore()
        session = store.create_session("子智能体集成")
        events = EventRecorder()
        runtime = MonAgentRuntime(Path.cwd(), store, events, None, None, object())
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        runtime.subagent_repository = SubagentThreadRepository(temporary.name)
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            None,
        )

        async def fake_stream(_model, context, _options):
            task = context["messages"][-1]["content"][0]["text"]
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": f"已完成：{task}"}],
                "stopReason": "stop",
                "timestamp": 1,
            }
            stream = AssistantMessageEventStream()
            stream.push({"type": "start", "partial": {**message, "content": []}})
            stream.push({"type": "done", "message": message})
            return stream

        dispatcher = runtime._make_subagent_dispatcher(
            session_id=session["id"],
            parent_path="/root",
            runtime_config=config,
            auth_token=None,
            environment=None,
            skill_owner_key=None,
            messages_provider=lambda: [],
        )

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            spawned = await dispatcher(
                "spawn",
                {
                    "message": "检查项目结构",
                    "task_name": "inspect_project",
                    "role": "researcher",
                    "fork_turns": "none",
                },
            )
            result = await dispatcher(
                "wait_agent",
                {"targets": [spawned["agentPath"]], "timeout_ms": 2_000},
            )

        self.assertEqual(result["agents"][0]["status"], "completed")
        self.assertEqual(result["messages"][0]["content"], "已完成：检查项目结构")
        self.assertEqual(store.list_messages(session["id"]), [])
        persisted = store.require_session(session["id"])["info"]["agentThreads"][0]
        self.assertEqual(persisted["role"], "researcher")
        self.assertEqual(persisted["status"], "completed")
        self.assertTrue(any(event["type"] == "subagent.completed" for event in events.events))

    async def test_turn_budget_stops_tool_loop_and_is_checkpointed(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        store = SessionStore()
        session = store.create_session("预算测试")
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        runtime.subagent_repository = SubagentThreadRepository(temporary.name)
        runtime.subagent_catalog = SubagentCatalog(
            (
                SubagentDefinition(
                    name="limited",
                    description="预算受限",
                    developer_instructions="调用工具。",
                    budget=SubagentBudget(max_turns=1, max_tool_calls=10, timeout_seconds=60),
                ),
            )
        )
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            None,
        )

        async def tool_loop_stream(_model, _context, _options):
            message = {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": "call-list", "name": "list_agents", "arguments": {}}],
                "stopReason": "tool_calls",
                "timestamp": 1,
            }
            stream = AssistantMessageEventStream()
            stream.push({"type": "start", "partial": {**message, "content": []}})
            stream.push({"type": "done", "message": message})
            return stream

        dispatcher = runtime._make_subagent_dispatcher(
            session_id=session["id"],
            parent_path="/root",
            runtime_config=config,
            auth_token=None,
            environment=None,
            skill_owner_key=None,
            messages_provider=lambda: [],
        )
        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=tool_loop_stream):
            spawned = await dispatcher(
                "spawn", {"message": "循环", "task_name": "limited", "role": "limited"}
            )
            result = await dispatcher(
                "wait_agent", {"targets": [spawned["agentPath"]], "timeout_ms": 2_000}
            )

        self.assertEqual(result["agents"][0]["status"], "failed")
        self.assertIn("模型轮次预算已耗尽", result["agents"][0]["error"])
        checkpoint = runtime.subagent_repository.thread_details(
            session["id"], spawned["agentPath"], include_messages=True
        )["checkpoint"]
        self.assertEqual(checkpoint["budget"]["maxTurns"], 1)
        self.assertEqual(checkpoint["budgetUsage"]["turnCount"], 1)
        self.assertEqual(checkpoint["budgetUsage"]["toolCallCount"], 1)

    async def test_tool_budget_blocks_additional_tool_execution(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        store = SessionStore()
        session = store.create_session("工具预算测试")
        runtime = MonAgentRuntime(Path.cwd(), store, EventRecorder(), None, None, object())
        runtime.subagent_repository = SubagentThreadRepository(temporary.name)
        runtime.subagent_catalog = SubagentCatalog(
            (
                SubagentDefinition(
                    name="limited",
                    description="预算受限",
                    developer_instructions="持续调用工具。",
                    budget=SubagentBudget(max_turns=10, max_tool_calls=1, timeout_seconds=60),
                ),
            )
        )
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            None,
        )
        calls = 0

        async def tool_loop_stream(_model, _context, _options):
            nonlocal calls
            calls += 1
            message = {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": f"call-{calls}", "name": "list_agents", "arguments": {}}],
                "stopReason": "tool_calls",
                "timestamp": calls,
            }
            stream = AssistantMessageEventStream()
            stream.push({"type": "start", "partial": {**message, "content": []}})
            stream.push({"type": "done", "message": message})
            return stream

        dispatcher = runtime._make_subagent_dispatcher(
            session_id=session["id"], parent_path="/root", runtime_config=config,
            auth_token=None, environment=None, skill_owner_key=None, messages_provider=lambda: [],
        )
        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=tool_loop_stream):
            spawned = await dispatcher(
                "spawn", {"message": "循环", "task_name": "tool_limited", "role": "limited"}
            )
            result = await dispatcher(
                "wait_agent", {"targets": [spawned["agentPath"]], "timeout_ms": 2_000}
            )

        self.assertEqual(result["agents"][0]["status"], "failed")
        self.assertIn("工具调用预算已耗尽", result["agents"][0]["error"])
        checkpoint = runtime.subagent_repository.thread_details(
            session["id"], spawned["agentPath"], include_messages=True
        )["checkpoint"]
        self.assertEqual(checkpoint["budgetUsage"]["toolCallCount"], 1)
        self.assertEqual(calls, 2)

    async def test_checkpoint_restores_thread_and_followup_after_runtime_restart(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repository = SubagentThreadRepository(temporary.name)
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            None,
        )

        async def fake_stream(_model, context, _options):
            task = context["messages"][-1]["content"][0]["text"]
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": f"完成：{task}"}],
                "stopReason": "stop",
                "timestamp": 1,
            }
            stream = AssistantMessageEventStream()
            stream.push({"type": "start", "partial": {**message, "content": []}})
            stream.push({"type": "done", "message": message})
            return stream

        first_store = SessionStore()
        session = first_store.create_session("恢复测试")
        first_runtime = MonAgentRuntime(Path.cwd(), first_store, EventRecorder(), None, None, object())
        first_runtime.subagent_repository = repository
        first_dispatcher = first_runtime._make_subagent_dispatcher(
            session_id=session["id"],
            parent_path="/root",
            runtime_config=config,
            auth_token=None,
            environment=None,
            skill_owner_key=None,
            messages_provider=lambda: [],
        )

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            spawned = await first_dispatcher(
                "spawn",
                {"message": "第一次任务", "task_name": "saved_worker", "role": "reviewer"},
            )
            await first_dispatcher("wait_agent", {"targets": [spawned["agentPath"]], "timeout_ms": 2_000})

            second_store = SessionStore()
            second_store.upsert_session_info(session)
            second_events = EventRecorder()
            second_runtime = MonAgentRuntime(Path.cwd(), second_store, second_events, None, None, object())
            second_runtime.subagent_repository = repository
            await second_runtime._ensure_subagent_control_restored(
                session_id=session["id"],
                parent_runtime_config=config,
                auth_token=None,
                environment=None,
                skill_owner_key=None,
            )
            second_dispatcher = second_runtime._make_subagent_dispatcher(
                session_id=session["id"],
                parent_path="/root",
                runtime_config=config,
                auth_token=None,
                environment=None,
                skill_owner_key=None,
                messages_provider=lambda: [],
            )
            await second_dispatcher(
                "followup_task",
                {"target": spawned["agentPath"], "message": "第二次任务"},
            )
            resumed = await second_dispatcher(
                "wait_agent",
                {"targets": [spawned["agentPath"]], "timeout_ms": 2_000},
            )

        self.assertEqual(resumed["agents"][0]["status"], "completed")
        self.assertEqual(resumed["messages"][0]["content"], "完成：第二次任务")
        details = repository.thread_details(session["id"], spawned["agentPath"], include_messages=True)
        self.assertGreaterEqual(len(details["checkpoint"]["messages"]), 4)
        self.assertEqual(details["checkpoint"]["budgetUsage"]["turnCount"], 2)
        self.assertEqual(second_store.list_messages(session["id"]), [])
        self.assertTrue(any(event["type"] == "subagent.restored" for event in second_events.events))

    async def test_unread_completion_survives_runtime_restart(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repository = SubagentThreadRepository(temporary.name)
        config = RuntimeModelConfig(
            {"id": "fake", "name": "Fake", "api": "fake", "provider": "fake", "input": ["text"]},
            None,
            "Fake",
            "test",
            None,
        )

        async def fake_stream(_model, _context, _options):
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": "持久化结果"}],
                "stopReason": "stop",
                "timestamp": 1,
            }
            stream = AssistantMessageEventStream()
            stream.push({"type": "start", "partial": {**message, "content": []}})
            stream.push({"type": "done", "message": message})
            return stream

        first_store = SessionStore()
        session = first_store.create_session("未读结果恢复")
        first_runtime = MonAgentRuntime(Path.cwd(), first_store, EventRecorder(), None, None, object())
        first_runtime.subagent_repository = repository
        first_dispatcher = first_runtime._make_subagent_dispatcher(
            session_id=session["id"],
            parent_path="/root",
            runtime_config=config,
            auth_token=None,
            environment=None,
            skill_owner_key=None,
            messages_provider=lambda: [],
        )

        with patch("mon_agent_server.runtime.manager.stream_openai_compatible", new=fake_stream):
            spawned = await first_dispatcher(
                "spawn",
                {"message": "执行", "task_name": "durable_result", "role": "reviewer"},
            )
            for _ in range(50):
                state = (await first_dispatcher("list_agents", {}))["agents"][0]
                if state["status"] == "completed":
                    break
                await asyncio.sleep(0.01)

        self.assertEqual(repository.list_mailbox(session["id"], "/root")[0]["content"], "持久化结果")

        second_store = SessionStore()
        second_store.upsert_session_info(session)
        second_runtime = MonAgentRuntime(Path.cwd(), second_store, EventRecorder(), None, None, object())
        second_runtime.subagent_repository = repository
        await second_runtime._ensure_subagent_control_restored(
            session_id=session["id"],
            parent_runtime_config=config,
            auth_token=None,
            environment=None,
            skill_owner_key=None,
        )
        restored = await second_runtime._make_subagent_dispatcher(
            session_id=session["id"],
            parent_path="/root",
            runtime_config=config,
            auth_token=None,
            environment=None,
            skill_owner_key=None,
            messages_provider=lambda: [],
        )("wait_agent", {"targets": [spawned["agentPath"]], "timeout_ms": 100})

        self.assertEqual(restored["messages"][0]["content"], "持久化结果")
        self.assertEqual(repository.list_mailbox(session["id"], "/root"), [])


if __name__ == "__main__":
    unittest.main()
