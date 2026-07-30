import unittest

from mon_agent_server.store import SessionStore


class StoreTest(unittest.TestCase):
    def test_message_pages_walk_backwards_without_duplicates(self):
        store = SessionStore()
        session = store.create_session("")
        store.hydrate_messages(
            session["id"],
            [
                {
                    "info": {"id": f"msg_{index}", "role": "user", "time": {"created": index + 1, "completed": index + 1}},
                    "parts": [],
                }
                for index in range(7)
            ],
        )

        first = store.list_message_page(session["id"], limit=3)
        second = store.list_message_page(session["id"], limit=3, before=first["nextCursor"])
        third = store.list_message_page(session["id"], limit=3, before=second["nextCursor"])

        self.assertEqual([item["info"]["id"] for item in first["items"]], ["msg_4", "msg_5", "msg_6"])
        self.assertEqual([item["info"]["id"] for item in second["items"]], ["msg_1", "msg_2", "msg_3"])
        self.assertEqual([item["info"]["id"] for item in third["items"]], ["msg_0"])
        self.assertTrue(first["hasMore"])
        self.assertTrue(second["hasMore"])
        self.assertFalse(third["hasMore"])

    def test_core_refresh_does_not_regress_terminal_subagent_state(self):
        store = SessionStore()
        session = store.create_session("")
        thread_id = "agt_test"
        store.upsert_agent_thread(
            session["id"],
            {"id": thread_id, "status": "completed", "updatedAt": 20, "result": {"content": "done"}},
        )

        refreshed = store.upsert_session_info(
            {
                "id": session["id"],
                "time": {"updated": 30},
                "agentThreads": [{"id": thread_id, "status": "running", "updatedAt": 10}],
            }
        )

        self.assertEqual(refreshed["agentThreads"][0]["status"], "completed")
        self.assertEqual(refreshed["agentThreads"][0]["result"]["content"], "done")

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

    def test_ui_hydration_does_not_create_model_context(self):
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
        self.assertEqual(store.context_messages(session["id"]), [])

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

        store.replace_context_messages(session["id"], canonical)
        events = store.model_events(session["id"])
        store.hydrate_messages(session["id"], [projection], events)

        self.assertEqual(store.context_messages(session["id"]), canonical)

    def test_append_context_message_keeps_tool_call_and_result_pair(self):
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

        store.append_context_message(session["id"], assistant)
        store.append_context_message(session["id"], result)

        saved = store.context_messages(session["id"])
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

    def test_ui_assistant_text_does_not_enter_context(self):
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
        self.assertEqual(store.context_messages(session["id"]), [])

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
        canonical = [
            {"role": "compactionSummary", "summary": "旧消息已经摘要。"},
            {"role": "user", "content": [{"type": "text", "text": "新消息"}]},
        ]
        store.replace_context_messages(session["id"], canonical)
        events = store.model_events(session["id"])
        store.hydrate_messages(session["id"], [old_message, compaction_message, new_message], events)

        self.assertEqual([message["info"]["id"] for message in store.list_messages(session["id"], 10)], ["msg_old", "msg_new"])
        self.assertEqual(
            [message["info"]["id"] for message in store.list_messages(session["id"], 10, include_compactions=True)],
            ["msg_old", compaction_message["info"]["id"], "msg_new"],
        )
        stored = store.context_messages(session["id"])
        self.assertEqual([message["role"] for message in stored], ["compactionSummary", "user"])
        self.assertEqual(stored[0]["summary"], "旧消息已经摘要。")

    def test_character_actions_are_isolated_and_remembered_per_character(self):
        store = SessionStore()
        session = store.create_session("")

        def state(character_id, character_name, action_id, action_name, timestamp):
            return {
                "sessionID": session["id"],
                "characterID": character_id,
                "characterName": character_name,
                "action": {"id": action_id, "name": action_name, "intent": "talk"},
                "motion": "none",
                "effect": "none",
                "performanceID": f"perf_{timestamp}",
                "time": timestamp,
            }

        store.set_character_action(session["id"], state(9, "莉莉安", 18, "抬手强调", 1))
        store.set_character_action(session["id"], state(10, "伊芙", 36, "单手抚胸陈述", 2))
        store.set_character_action(session["id"], state(9, "莉莉安", 20, "星星眼握拳兴奋", 3))

        self.assertEqual(store.get_character_action(session["id"], 9)["action"]["name"], "星星眼握拳兴奋")
        self.assertEqual(store.get_character_action(session["id"], 10)["action"]["name"], "单手抚胸陈述")
        self.assertEqual(
            [item["actionName"] for item in store.get_character_action_history(session["id"], 9)],
            ["星星眼握拳兴奋", "抬手强调"],
        )
        self.assertIn("9", session["characterPerformances"])
        self.assertIn("10", session["characterPerformances"])

    def test_default_character_action_does_not_pollute_recent_choices(self):
        store = SessionStore()
        session = store.create_session("")
        store.set_character_action(
            session["id"],
            {
                "characterID": 10,
                "action": {"id": 35, "name": "抚胸垂手", "intent": "idle"},
                "source": "default",
            },
            record_history=False,
        )

        self.assertEqual(store.get_character_action_history(session["id"], 10), [])
        self.assertEqual(store.get_character_action(session["id"], 10)["action"]["name"], "抚胸垂手")


if __name__ == "__main__":
    unittest.main()
