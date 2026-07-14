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
            first_kept_entry_id="runtime_000010",
            created_at=2,
        )
        new_message = {
            "info": {"id": "msg_new", "role": "user", "time": {"created": 3, "completed": 3}},
            "parts": [{"id": "part_new", "messageID": "msg_new", "sessionID": session["id"], "type": "text", "text": "新消息"}],
        }
        store.hydrate_messages(session["id"], [old_message, compaction_message, new_message])

        self.assertEqual([message["info"]["id"] for message in store.list_messages(session["id"], 10)], ["msg_old", "msg_new"])
        stored = store.require_session(session["id"])
        self.assertEqual([message["role"] for message in stored["agentMessages"]], ["compactionSummary", "user"])
        self.assertEqual(stored["agentMessages"][0]["summary"], "旧消息已经摘要。")


if __name__ == "__main__":
    unittest.main()
