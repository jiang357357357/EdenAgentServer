from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from mon_agent_server.store.subagent_repository import SubagentThreadRepository


class SubagentThreadRepositoryTest(unittest.TestCase):
    def test_persists_metadata_events_and_checkpoint_independently(self) -> None:
        with TemporaryDirectory() as directory:
            repository = SubagentThreadRepository(directory)
            thread = {
                "id": "agt_1",
                "rootSessionID": "ses/unsafe",
                "agentPath": "/root/reviewer",
                "taskName": "review",
                "role": "reviewer",
                "status": "running",
                "depth": 1,
                "createdAt": 1,
                "updatedAt": 2,
            }

            repository.upsert_thread("ses/unsafe", thread)
            repository.append_event(
                "ses/unsafe",
                "agt_1",
                {"type": "tool_execution_start", "toolName": "read"},
            )
            repository.save_checkpoint(
                "ses/unsafe",
                "agt_1",
                {"messages": [{"role": "assistant", "content": [{"type": "text", "text": "完成"}]}]},
            )

            details = repository.thread_details("ses/unsafe", "/root/reviewer", include_messages=True)
            self.assertEqual(details["thread"]["status"], "running")
            self.assertEqual(details["events"][0]["toolName"], "read")
            self.assertEqual(details["checkpoint"]["messages"][0]["role"], "assistant")
            self.assertNotIn("ses/unsafe", str(next(Path(directory).iterdir())))

    def test_reconcile_marks_inflight_threads_interrupted_once(self) -> None:
        with TemporaryDirectory() as directory:
            repository = SubagentThreadRepository(directory)
            repository.upsert_thread(
                "ses_1",
                {
                    "id": "agt_1",
                    "agentPath": "/root/coder",
                    "taskName": "code",
                    "role": "coder",
                    "status": "running",
                    "depth": 1,
                    "createdAt": 1,
                    "updatedAt": 2,
                },
            )

            recovered = repository.reconcile_inflight("ses_1")
            repeated = repository.reconcile_inflight("ses_1")

            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovered[0]["status"], "interrupted")
            self.assertTrue(recovered[0]["metadata"]["recoveredAfterRestart"])
            self.assertEqual(repeated, [])
            events = repository.list_events("ses_1", "agt_1")
            self.assertEqual(events[-1]["type"], "recovery.interrupted")

    def test_mailbox_persists_until_receiver_consumes_messages(self) -> None:
        with TemporaryDirectory() as directory:
            repository = SubagentThreadRepository(directory)
            message = {
                "id": "a2a_1",
                "sender": "/root/worker",
                "target": "/root",
                "content": "完成",
                "kind": "result",
                "createdAt": 1,
            }

            repository.enqueue_message("ses_1", message)
            repository.enqueue_message("ses_1", message)

            self.assertEqual(repository.list_mailbox("ses_1"), [message])
            self.assertEqual(repository.consume_messages("ses_1", "/root", ["a2a_1"]), 1)
            self.assertEqual(repository.list_mailbox("ses_1"), [])

    def test_truncated_final_event_does_not_hide_valid_history(self) -> None:
        with TemporaryDirectory() as directory:
            repository = SubagentThreadRepository(directory)
            repository.upsert_thread(
                "ses_1",
                {
                    "id": "agt_1",
                    "agentPath": "/root/worker",
                    "status": "completed",
                    "createdAt": 1,
                },
            )
            repository.append_event("ses_1", "agt_1", {"type": "message_end"})
            event_file = next(Path(directory).glob("*/*/events.jsonl"))
            with event_file.open("a", encoding="utf-8") as handle:
                handle.write('{"type":"broken"')

            self.assertEqual([item["type"] for item in repository.list_events("ses_1", "agt_1")], ["message_end"])


if __name__ == "__main__":
    unittest.main()
