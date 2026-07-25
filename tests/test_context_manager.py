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


if __name__ == "__main__":
    unittest.main()
