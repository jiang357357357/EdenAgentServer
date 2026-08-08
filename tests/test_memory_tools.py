import unittest
from unittest.mock import AsyncMock, patch

from mon_agent_server.memory import extract_turn_memories
from mon_agent_server.prompts.builder import build_agent_system_prompt
from mon_agent_server.tools.context import MonToolContext
from mon_agent_server.tools.memory import create_memory_tools


class FakeMemoryCore:
    def __init__(self):
        self.memories = []
        self.last_query = None

    def remember_memory(self, token, payload):
        memory = {
            "id": len(self.memories) + 1,
            **payload,
            "status": "active",
            "created_at": "2026-08-05T16:00:00+08:00",
            "updated_at": "2026-08-05T16:00:00+08:00",
        }
        self.memories.append(memory)
        return memory

    def list_memories(self, token, params):
        self.last_query = params
        return list(self.memories)

    def update_memory(self, token, memory_id, payload):
        self.memories[memory_id - 1].update(payload)
        return self.memories[memory_id - 1]

    def forget_memory(self, token, memory_id):
        self.memories[memory_id - 1]["status"] = "forgotten"
        return self.memories[memory_id - 1]


def by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class MemoryToolsTest(unittest.IsolatedAsyncioTestCase):
    async def test_root_can_manage_memory_and_subagent_is_read_only(self):
        core = FakeMemoryCore()
        root = create_memory_tools(MonToolContext(
            core_client=core,
            core_token="token",
            session_id="ses",
            agent_path="/root",
            character={"id": 7},
        ))
        result = await by_name(root, "remember_memory").execute("call", {"content": "用户喜欢简洁回答", "kind": "preference"})
        self.assertIn("已写入长期记忆", result["content"][0]["text"])
        self.assertEqual(core.memories[0]["scope_type"], "agent_character")
        self.assertEqual(core.memories[0]["agent_character"], 7)
        found = await by_name(root, "search_memories").execute("call", {"query": "简洁"})
        self.assertEqual(found["details"]["count"], 1)
        self.assertIn("写入时间（本地）: 2026-08-05 16:00:00", found["content"][0]["text"])

        child = create_memory_tools(MonToolContext(core_client=core, core_token="token", agent_path="/root/child"))
        with self.assertRaisesRegex(RuntimeError, "子智能体只能检索"):
            await by_name(child, "forget_memory").execute("call", {"id": 1})

    async def test_secret_is_rejected_before_core(self):
        tools = create_memory_tools(MonToolContext(
            core_client=FakeMemoryCore(),
            core_token="token",
            character={"id": 7},
        ))
        with self.assertRaisesRegex(ValueError, "密钥"):
            await by_name(tools, "remember_memory").execute("call", {"content": "api_key: sk-abcdefghijklmnopqrstuv"})

    async def test_agent_character_memory_uses_distinct_scope_and_field(self):
        core = FakeMemoryCore()
        tools = create_memory_tools(
            MonToolContext(
                core_client=core,
                core_token="token",
                session_id="ses",
                agent_path="/root",
                character={"id": 7},
            )
        )

        await by_name(tools, "remember_memory").execute(
            "call",
            {
                "content": "智能体角色记得与用户看过星星",
                "kind": "fact",
                "scope_type": "agent_character",
            },
        )
        self.assertEqual(core.memories[0]["agent_character"], 7)
        self.assertEqual(core.memories[0]["scope_key"], "7")

        await by_name(tools, "search_memories").execute("call", {"query": "星星"})
        self.assertEqual(core.last_query["agent_character"], 7)

    async def test_automatic_extraction_persists_safe_high_confidence_memory(self):
        core = FakeMemoryCore()
        stream = AsyncMock()
        stream.result.return_value = {
            "content": [{"type": "text", "text": '{"memories":[{"kind":"preference","content":"用户偏好简洁回答","confidence":0.96}]}'}]
        }
        runtime = type("Runtime", (), {"api_key": "key", "model": {"id": "test"}})()
        with patch("mon_agent_server.memory.stream_openai_compatible", AsyncMock(return_value=stream)):
            saved = await extract_turn_memories(
                core_client=core,
                core_token="token",
                runtime_config=runtime,
                session_id="ses",
                user_message_id="msg",
                user_text="我喜欢简洁回答",
                assistant_text="明白了。",
                assistant_id=1,
                agent_character_id=7,
            )
        self.assertEqual(saved[0]["content"], "用户偏好简洁回答")
        self.assertEqual(saved[0]["scope_type"], "agent_character")
        self.assertEqual(saved[0]["agent_character"], 7)

    def test_recalled_memories_are_bounded_context_not_rules(self):
        prompt = build_agent_system_prompt(
            relevant_memories=[{"content": "用户偏好简洁回答"}],
            delegation_mode="disabled",
        )
        self.assertIn("# 相关长期记忆", prompt)
        self.assertIn("若与用户当前陈述冲突，以当前陈述为准", prompt)
