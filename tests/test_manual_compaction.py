import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from mon_agent_core.harness.types import ok

from mon_agent_server.runtime import MonAgentRuntime
from mon_agent_server.runtime.manager import NoCompactionNeeded
from mon_agent_server.runtime.config import RuntimeModelConfig
from mon_agent_server.runtime.state import RunState
from mon_agent_server.store import SessionStore


class CapturingEvents:
    def __init__(self):
        self.items = []

    def emit(self, event):
        self.items.append(event)


class ManualCompactionTest(unittest.IsolatedAsyncioTestCase):
    async def test_forced_compaction_persists_and_emits_manual_checkpoint(self):
        store = SessionStore()
        session = store.create_session("主动压缩")
        session_id = session["id"]
        events = CapturingEvents()
        runtime = MonAgentRuntime(Path.cwd(), store, events, None, None, object())
        messages = [
            {
                "role": "user",
                "timestamp": 1,
                "content": [{"type": "text", "text": "旧上下文" * 12_000}],
            },
            {
                "role": "assistant",
                "timestamp": 2,
                "content": [{"type": "text", "text": "旧回答" * 12_000}],
                "usage": {"input": 90_000, "output": 1_000, "cacheRead": 0},
            },
            {
                "role": "user",
                "timestamp": 3,
                "content": [{"type": "text", "text": "最近问题"}],
            },
        ]
        store.replace_context_messages(session_id, messages)
        runtime_config = RuntimeModelConfig(
            {"id": "gpt-test", "provider": "openai", "contextWindow": 128_000},
            "test-key",
            "openai/gpt-test",
            "core",
            None,
        )
        captured = {}

        async def fake_compact(preparation, _models, _model, custom_instructions, _signal, _thinking_level):
            captured["instructions"] = custom_instructions
            return ok(
                {
                    "summary": "保留关键路径后的摘要",
                    "firstKeptEntryId": preparation["firstKeptEntryId"],
                    "tokensBefore": preparation["tokensBefore"],
                    "details": {"readFiles": [], "modifiedFiles": []},
                }
            )

        with patch("mon_agent_server.runtime.execution.compaction.compact_context", side_effect=fake_compact):
            compacted = await runtime.compact_agent_messages_if_needed(
                session_id,
                RunState(),
                runtime_config,
                messages,
                10_000,
                None,
                force=True,
                custom_instructions="重点保留项目路径",
            )

        saved = store.require_session(session_id)
        compaction_message = next(
            message
            for message in saved["messages"]
            if any(part.get("type") == "compaction" for part in message.get("parts", []))
        )
        compaction_part = compaction_message["parts"][0]

        self.assertEqual(captured["instructions"], "重点保留项目路径")
        self.assertEqual(compacted[0]["role"], "compactionSummary")
        self.assertTrue(all("usage" not in message for message in compacted))
        self.assertEqual(store.context_messages(session_id), compacted)
        self.assertFalse(compaction_part["auto"])
        self.assertFalse(compaction_part["overflow"])
        self.assertGreater(compaction_part["tokensBefore"], compaction_part["tokensAfter"])
        self.assertTrue(
            any(
                event.get("type") == "message.part.updated"
                and event.get("properties", {}).get("part", {}).get("type") == "compaction"
                for event in events.items
            )
        )

    async def test_forced_compaction_preserves_two_recent_turns_below_eight_thousand_tokens(self):
        store = SessionStore()
        session = store.create_session("短会话压缩")
        session_id = session["id"]
        events = CapturingEvents()
        runtime = MonAgentRuntime(Path.cwd(), store, events, None, None, object())
        messages = [
            {"role": "user", "timestamp": 1, "content": [{"type": "text", "text": "第一轮问题" * 120}]},
            {"role": "assistant", "timestamp": 2, "content": [{"type": "text", "text": "第一轮回答" * 120}]},
            {"role": "user", "timestamp": 3, "content": [{"type": "text", "text": "最近问题"}]},
            {"role": "assistant", "timestamp": 4, "content": [{"type": "text", "text": "最近回答"}]},
            {"role": "user", "timestamp": 5, "content": [{"type": "text", "text": "当前问题"}]},
            {"role": "assistant", "timestamp": 6, "content": [{"type": "text", "text": "当前回答"}]},
        ]
        store.replace_context_messages(session_id, messages)
        runtime_config = RuntimeModelConfig(
            {"id": "gpt-test", "provider": "openai", "contextWindow": 128_000},
            "test-key",
            "openai/gpt-test",
            "core",
            None,
        )
        captured = {}

        async def fake_compact(preparation, _models, _model, _instructions, _signal, _thinking_level):
            captured["preparation"] = preparation
            return ok(
                {
                    "summary": "第一轮摘要",
                    "firstKeptEntryId": preparation["firstKeptEntryId"],
                    "tokensBefore": preparation["tokensBefore"],
                    "details": {"readFiles": [], "modifiedFiles": []},
                }
            )

        with patch("mon_agent_server.runtime.execution.compaction.compact_context", side_effect=fake_compact):
            await runtime.compact_agent_messages_if_needed(
                session_id,
                RunState(),
                runtime_config,
                messages,
                10_000,
                None,
                force=True,
            )

        preparation = captured["preparation"]
        self.assertEqual(len(preparation["messagesToSummarize"]), 2)
        self.assertEqual(preparation["firstKeptEntryId"], "runtime_000002")

    async def test_manual_compaction_failure_finishes_runtime_message(self):
        store = SessionStore()
        session = store.create_session("压缩失败")
        session_id = session["id"]
        store.replace_context_messages(
            session_id,
            [{"role": "user", "timestamp": 1, "content": [{"type": "text", "text": "仅一轮"}]}],
        )
        events = CapturingEvents()
        runtime = MonAgentRuntime(Path.cwd(), store, events, None, None, object())
        runtime_config = RuntimeModelConfig(
            {"id": "gpt-test", "provider": "openai", "contextWindow": 128_000},
            "test-key",
            "openai/gpt-test",
            "core",
            None,
        )

        with (
            patch.object(runtime, "_resolve_runtime_config", new=AsyncMock(return_value=runtime_config)),
            patch.object(
                runtime,
                "compact_agent_messages_if_needed",
                new=AsyncMock(side_effect=RuntimeError("没有可压缩的旧对话")),
            ),
        ):
            await runtime._run_manual_compaction(session_id, None, None)

        runtime_message = next(
            message
            for message in store.require_session(session_id)["messages"]
            if any(part.get("type") == "reasoning" for part in message.get("parts", []))
        )
        self.assertIsNotNone(runtime_message["info"]["time"].get("completed"))
        self.assertTrue(
            any(
                event.get("type") == "session.status"
                and event.get("properties", {}).get("status", {}).get("type") == "idle"
                for event in events.items
            )
        )

    async def test_manual_compaction_without_old_context_is_a_completed_noop(self):
        store = SessionStore()
        session = store.create_session("无需压缩")
        session_id = session["id"]
        store.replace_context_messages(
            session_id,
            [{"role": "user", "timestamp": 1, "content": [{"type": "text", "text": "仅一轮"}]}],
        )
        events = CapturingEvents()
        runtime = MonAgentRuntime(Path.cwd(), store, events, None, None, object())
        runtime_config = RuntimeModelConfig(
            {"id": "gpt-test", "provider": "openai", "contextWindow": 128_000},
            "test-key",
            "openai/gpt-test",
            "core",
            None,
        )

        with (
            patch.object(runtime, "_resolve_runtime_config", new=AsyncMock(return_value=runtime_config)),
            patch.object(
                runtime,
                "compact_agent_messages_if_needed",
                new=AsyncMock(side_effect=NoCompactionNeeded("当前上下文仍在保留范围内，无需压缩。")),
            ),
        ):
            await runtime._run_manual_compaction(session_id, None, None)

        runtime_message = next(
            message
            for message in store.require_session(session_id)["messages"]
            if any(part.get("type") == "reasoning" for part in message.get("parts", []))
        )
        self.assertIsNotNone(runtime_message["info"]["time"].get("completed"))
        self.assertIsNone(runtime_message["info"].get("error"))
        self.assertTrue(
            any(
                part.get("type") == "reasoning" and "无需压缩" in part.get("text", "")
                for part in runtime_message["parts"]
            )
        )
        self.assertFalse(any(event.get("type") == "session.error" for event in events.items))
        self.assertTrue(
            any(
                event.get("type") == "session.status"
                and event.get("properties", {}).get("status", {}).get("type") == "idle"
                for event in events.items
            )
        )


if __name__ == "__main__":
    unittest.main()
