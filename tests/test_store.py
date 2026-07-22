import unittest

from mon_agent_server.store import SessionStore


class StoreTest(unittest.TestCase):
    def test_session_store_creates_and_appends_messages(self):
        store = SessionStore()
        session = store.create_session("")
        message = store.append_user_message(
            session["id"],
            "你好，MonAgent",
            [{"url": "data:text/plain,hello", "mime": "text/plain", "filename": "hello.txt"}],
        )

        self.assertEqual(session["title"], "你好，MonAgent")
        self.assertEqual(message["info"]["role"], "user")
        self.assertEqual(len(message["parts"]), 2)
        self.assertEqual(store.list_messages(session["id"], 10)[0]["info"]["id"], message["info"]["id"])

    def test_session_store_hydrates_agent_messages(self):
        store = SessionStore()
        session = store.create_session("")
        store.hydrate_messages(
            session["id"],
            [
                {
                    "info": {"id": "msg_1", "role": "user", "time": {"created": 1, "completed": 1}},
                    "parts": [
                        {"id": "part_1", "messageID": "msg_1", "sessionID": session["id"], "type": "text", "text": "第一条"}
                    ],
                }
            ],
        )

        stored = store.require_session(session["id"])
        self.assertEqual(stored["info"]["title"], "第一条")
        self.assertEqual(stored["agentMessages"][0]["role"], "user")

    def test_structured_agent_messages_are_canonical_after_hydration(self):
        store = SessionStore()
        session = store.create_session("")
        projection = {
            "info": {"id": "msg_assistant", "role": "assistant", "time": {"created": 1, "completed": 2}},
            "parts": [
                {
                    "id": "call_1",
                    "messageID": "msg_assistant",
                    "sessionID": session["id"],
                    "type": "tool",
                    "tool": "read",
                    "state": {"status": "completed", "input": {"path": "a.txt"}, "output": "内容"},
                },
                {
                    "id": "text_1",
                    "messageID": "msg_assistant",
                    "sessionID": session["id"],
                    "type": "text",
                    "text": "读取完成。",
                },
            ],
        }
        canonical = [
            {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": "call_1", "name": "read", "arguments": {"path": "a.txt"}}],
                "timestamp": 1,
            },
            {
                "role": "toolResult",
                "toolCallId": "call_1",
                "toolName": "read",
                "content": [{"type": "text", "text": "内容"}],
                "isError": False,
                "timestamp": 2,
            },
        ]

        store.hydrate_messages(session["id"], [projection], canonical)

        self.assertEqual(store.require_session(session["id"])["agentMessages"], canonical)

    def test_append_agent_message_keeps_tool_call_and_result_pair(self):
        store = SessionStore()
        session = store.create_session("")
        assistant = {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": "call_1", "name": "bash", "arguments": {"command": "pwd"}}],
        }
        result = {
            "role": "toolResult",
            "toolCallId": "call_1",
            "toolName": "bash",
            "content": [{"type": "text", "text": "/workspace"}],
            "isError": False,
        }

        store.append_agent_message(session["id"], assistant)
        store.append_agent_message(session["id"], result)

        saved = store.require_session(session["id"])["agentMessages"]
        self.assertEqual(saved[0]["content"][0]["id"], saved[1]["toolCallId"])
        assistant["content"][0]["arguments"]["command"] = "mutated"
        self.assertEqual(saved[0]["content"][0]["arguments"]["command"], "pwd")

    def test_hydration_preserves_local_assistant_missing_from_core(self):
        store = SessionStore()
        session = store.create_session("")
        user_message = store.append_user_message(session["id"], "用户消息", [])
        assistant_info = {
            "id": "msg_assistant_local",
            "role": "assistant",
            "time": {"created": 2, "completed": 3},
        }
        store.upsert_message(session["id"], assistant_info)
        store.upsert_part(
            session["id"],
            {
                "id": "part_assistant_local",
                "messageID": "msg_assistant_local",
                "sessionID": session["id"],
                "type": "text",
                "text": "尚未同步到 Core 的助手回复",
            },
        )

        store.hydrate_messages(session["id"], [user_message])

        messages = store.list_messages(session["id"], 10)
        self.assertEqual([message["info"]["role"] for message in messages], ["assistant", "user"])
        self.assertEqual(messages[0]["parts"][0]["text"], "尚未同步到 Core 的助手回复")

    def test_assistant_speaker_stays_metadata_and_does_not_modify_text(self):
        store = SessionStore()
        session = store.create_session("")
        assistant_info = {
            "id": "msg_assistant_lily",
            "role": "assistant",
            "speaker": {"assistantName": "莉莉安"},
            "time": {"created": 2, "completed": 3},
        }
        store.upsert_message(session["id"], assistant_info)
        store.upsert_part(
            session["id"],
            {
                "id": "part_assistant_lily",
                "messageID": "msg_assistant_lily",
                "sessionID": session["id"],
                "type": "text",
                "text": "托腮，歪头想了想",
            },
        )
        store.rebuild_agent_messages(session["id"])

        context_message = store.require_session(session["id"])["agentMessages"][0]
        self.assertEqual(context_message["content"][0]["text"], "托腮，歪头想了想")
        self.assertEqual(context_message["contextSpeaker"]["assistantName"], "莉莉安")

    def test_compaction_message_is_hidden_and_resets_agent_context(self):
        store = SessionStore()
        session = store.create_session("")
        old_message = {
            "info": {"id": "msg_old", "role": "user", "time": {"created": 1, "completed": 1}},
            "parts": [{"id": "part_old", "messageID": "msg_old", "sessionID": session["id"], "type": "text", "text": "旧消息"}],
        }
        compaction_message = store.append_compaction_message(
            session["id"],
            summary="旧消息已经摘要。",
            tokens_before=120000,
            tokens_after=18000,
            first_kept_entry_id="runtime_000010",
            created_at=2,
        )
        new_message = {
            "info": {"id": "msg_new", "role": "user", "time": {"created": 3, "completed": 3}},
            "parts": [{"id": "part_new", "messageID": "msg_new", "sessionID": session["id"], "type": "text", "text": "新消息"}],
        }
        store.hydrate_messages(session["id"], [old_message, compaction_message, new_message])

        self.assertEqual([message["info"]["id"] for message in store.list_messages(session["id"], 10)], ["msg_old", "msg_new"])
        self.assertEqual(
            [message["info"]["id"] for message in store.list_messages(session["id"], 10, include_compactions=True)],
            ["msg_old", compaction_message["info"]["id"], "msg_new"],
        )
        stored = store.require_session(session["id"])
        self.assertEqual([message["role"] for message in stored["agentMessages"]], ["compactionSummary", "user"])
        self.assertEqual(stored["agentMessages"][0]["summary"], "旧消息已经摘要。")


if __name__ == "__main__":
    unittest.main()
