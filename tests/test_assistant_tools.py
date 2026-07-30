from __future__ import annotations

import unittest
from unittest.mock import AsyncMock

from mon_agent_server.store import SessionStore
from mon_agent_server.tools.assistants import create_assistant_tools
from mon_agent_server.tools.context import MonToolContext


def by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class FakeAssistantCore:
    def list_assistants(self, token):
        self.token = token
        return [
            {
                "id": 2,
                "name": "助手 B",
                "is_current": False,
                "character": {"id": 20, "name": "角色 B"},
            }
        ]


class AssistantToolsTest(unittest.IsolatedAsyncioTestCase):
    async def test_list_assistants_returns_core_assistants(self):
        core = FakeAssistantCore()
        tools = create_assistant_tools(MonToolContext(core_client=core, core_token="token"))

        result = await by_name(tools, "list_assistants").execute("call-list", {})

        self.assertEqual(core.token, "token")
        self.assertEqual(result["details"]["assistants"][0]["id"], 2)
        self.assertIn("助手 B", result["content"][0]["text"])

    async def test_switch_uses_session_callback_and_reports_history_preservation(self):
        switch = AsyncMock(
            return_value={
                "assistant": {"id": 2, "name": "助手 B"},
                "historyPreserved": True,
                "effectiveFrom": "next_model_continuation",
            }
        )
        tools = create_assistant_tools(
            MonToolContext(session_id="ses-1", switch_session_assistant=switch, agent_path="/root")
        )

        result = await by_name(tools, "switch_session_assistant").execute(
            "call-switch",
            {"assistant_id": 2},
        )

        switch.assert_awaited_once_with(2)
        self.assertTrue(result["details"]["historyPreserved"])
        self.assertIn("下一次模型续跑", result["content"][0]["text"])

    async def test_subagent_cannot_switch_session_assistant(self):
        tools = create_assistant_tools(
            MonToolContext(switch_session_assistant=AsyncMock(), agent_path="/root/child")
        )

        with self.assertRaisesRegex(RuntimeError, "父智能体"):
            await by_name(tools, "switch_session_assistant").execute(
                "call-switch",
                {"assistant_id": 2},
            )

    def test_participant_switch_preserves_existing_messages_and_model_events(self):
        store = SessionStore()
        session = store.create_session(
            "同一会话",
            [{"assistantID": 1, "assistantName": "助手 A", "characterID": 10}],
        )
        session_id = session["id"]
        store.append_user_message(session_id, "用户和 A 的历史", [])
        store.append_context_message(
            session_id,
            {"role": "assistant", "content": [{"type": "text", "text": "A 的回复"}]},
        )
        messages_before = list(store.require_session(session_id)["messages"])
        events_before = list(store.require_session(session_id)["modelEvents"])

        store.update_participants(
            session_id,
            [{"assistantID": 2, "assistantName": "助手 B", "characterID": 20}],
        )

        updated = store.require_session(session_id)
        self.assertEqual(updated["info"]["participantAssistantIDs"], [2])
        self.assertEqual(updated["messages"], messages_before)
        self.assertEqual(updated["modelEvents"], events_before)
