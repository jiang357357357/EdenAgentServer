from __future__ import annotations

import unittest

from mon_agent_server.context import ContextManager


def event(sequence: int, event_type: str, payload: dict) -> dict:
    return {
        "id": f"evt_{sequence}",
        "sequence": sequence,
        "type": event_type,
        "payload": payload,
        "createdAt": sequence,
    }


class ContextManagerTests(unittest.TestCase):
    def test_compiles_only_model_visible_events_in_sequence_order(self):
        events = [
            event(3, "turn_completed", {"runID": "run_1"}),
            event(2, "assistant_message", {"role": "assistant", "content": [{"type": "text", "text": "你好"}]}),
            event(1, "user_message", {"role": "user", "content": "你好"}),
        ]

        messages = ContextManager.compile(events)

        self.assertEqual([message["role"] for message in messages], ["user", "assistant"])

    def test_ignores_orphan_tool_result_but_keeps_matching_result(self):
        events = [
            event(
                1,
                "assistant_message",
                {"role": "assistant", "content": [{"type": "toolCall", "id": "call_1", "name": "read"}]},
            ),
            event(2, "tool_result", {"role": "toolResult", "toolCallId": "orphan", "content": "no"}),
            event(3, "tool_result", {"role": "toolResult", "toolCallId": "call_1", "content": "ok"}),
        ]

        messages = ContextManager.compile(events)

        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[-1]["toolCallId"], "call_1")

    def test_compaction_replaces_earlier_history(self):
        events = [
            event(1, "user_message", {"role": "user", "content": "旧消息"}),
            event(2, "compaction", {"role": "compactionSummary", "content": "摘要"}),
            event(3, "user_message", {"role": "user", "content": "新消息"}),
        ]

        messages = ContextManager.compile(events)

        self.assertEqual([message["role"] for message in messages], ["compactionSummary", "user"])
        self.assertEqual(messages[-1]["content"], "新消息")

    def test_long_text_is_bounded_without_mutating_event_payload(self):
        original = "x" * (ContextManager.MAX_TEXT_CHARS + 10)
        source = event(1, "user_message", {"role": "user", "content": original})

        messages = ContextManager.compile([source])

        self.assertIn("...[truncated 10 chars]", messages[0]["content"])
        self.assertEqual(source["payload"]["content"], original)

    def test_failed_assistant_messages_are_removed_from_existing_history(self):
        events = [
            event(1, "user_message", {"role": "user", "content": "第一次请求"}),
            event(
                2,
                "assistant_message",
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": ""}],
                    "stopReason": "error",
                    "errorMessage": "SSL EOF",
                },
            ),
            event(3, "user_message", {"role": "user", "content": "重新请求"}),
        ]

        messages = ContextManager.compile(events)

        self.assertEqual([message["role"] for message in messages], ["user", "user"])
        self.assertEqual(messages[-1]["content"], "重新请求")

    def test_prunes_large_old_tool_results_but_keeps_recent_two_user_turns(self):
        large = "x" * 20_000
        events = [
            event(1, "user_message", {"role": "user", "content": "第一轮"}),
            event(2, "assistant_message", {"role": "assistant", "content": [{"type": "toolCall", "id": "old_1", "name": "grep"}]}),
            event(3, "tool_result", {"role": "toolResult", "toolCallId": "old_1", "content": large}),
            event(4, "assistant_message", {"role": "assistant", "content": [{"type": "toolCall", "id": "old_2", "name": "ls"}]}),
            event(5, "tool_result", {"role": "toolResult", "toolCallId": "old_2", "content": large}),
            event(6, "assistant_message", {"role": "assistant", "content": [{"type": "toolCall", "id": "old_3", "name": "read"}]}),
            event(7, "tool_result", {"role": "toolResult", "toolCallId": "old_3", "content": large}),
            event(8, "user_message", {"role": "user", "content": "第二轮"}),
            event(9, "assistant_message", {"role": "assistant", "content": [{"type": "toolCall", "id": "recent", "name": "read"}]}),
            event(10, "tool_result", {"role": "toolResult", "toolCallId": "recent", "content": large}),
            event(11, "user_message", {"role": "user", "content": "第三轮"}),
        ]

        messages = ContextManager.compile(events)
        results = {message["toolCallId"]: message["content"] for message in messages if message["role"] == "toolResult"}

        self.assertEqual(results["old_1"][0]["text"], ContextManager.PRUNED_TOOL_RESULT_TEXT)
        self.assertIsInstance(results["old_3"], str)
        self.assertIsInstance(results["recent"], str)

    def test_does_not_prune_small_old_tool_history(self):
        events = [
            event(1, "user_message", {"role": "user", "content": "第一轮"}),
            event(2, "assistant_message", {"role": "assistant", "content": [{"type": "toolCall", "id": "old", "name": "read"}]}),
            event(3, "tool_result", {"role": "toolResult", "toolCallId": "old", "content": "small"}),
            event(4, "user_message", {"role": "user", "content": "第二轮"}),
            event(5, "user_message", {"role": "user", "content": "第三轮"}),
        ]

        messages = ContextManager.compile(events)

        self.assertEqual(messages[2]["content"], "small")


if __name__ == "__main__":
    unittest.main()
