import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from mon_agent_server.runtime import MonAgentRuntime
from mon_agent_server.runtime.emitters import RuntimeEmitterMixin, runtime_error_summary
from mon_agent_server.runtime.state import RunState
from mon_agent_server.store import SessionStore


class TransientCoreClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.message_attempts = 0

    def sync_agent_message(self, _token, _session, _message, _core):
        self.message_attempts += 1
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class RecordingCoreClient:
    def __init__(self):
        self.session = None

    def sync_agent_message(self, _token, session, _message, _core):
        self.session = session
        return {"sync_status": "synced"}


class EventRecorder:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


class EmitterHarness(RuntimeEmitterMixin):
    def __init__(self, store):
        self.store = store
        self.events = EventRecorder()


class RuntimePersistenceTest(unittest.IsolatedAsyncioTestCase):
    def runtime_with(self, core_client):
        store = SessionStore()
        session = store.create_session("重试测试")
        runtime = MonAgentRuntime(Path.cwd(), store, None, None, None, core_client)
        message = store.append_user_message(session["id"], "消息", [])
        return runtime, session, message

    async def test_message_sync_retries_transient_core_failure(self):
        core = TransientCoreClient([RuntimeError("database is locked"), RuntimeError("temporary 500"), {"sync_status": "synced"}])
        runtime, session, message = self.runtime_with(core)

        with patch("mon_agent_server.runtime.manager.asyncio.sleep", new=AsyncMock()) as sleep:
            await runtime.sync_core_message(session["id"], message, "token", None)

        self.assertEqual(core.message_attempts, 3)
        self.assertEqual(sleep.await_count, 2)

    async def test_message_sync_retries_failed_projection(self):
        core = TransientCoreClient([{"sync_status": "failed"}, {"sync_status": "synced"}])
        runtime, session, message = self.runtime_with(core)

        with patch("mon_agent_server.runtime.manager.asyncio.sleep", new=AsyncMock()) as sleep:
            await runtime.sync_core_message(session["id"], message, "token", None)

        self.assertEqual(core.message_attempts, 2)
        self.assertEqual(sleep.await_count, 1)

    async def test_message_sync_carries_canonical_context_to_core(self):
        core = RecordingCoreClient()
        runtime, session, message = self.runtime_with(core)
        runtime.store.replace_context_messages(
            session["id"],
            [
                {
                    "role": "assistant",
                    "content": [{"type": "toolCall", "id": "call_1", "name": "read", "arguments": {}}],
                },
                {
                    "role": "toolResult",
                    "toolCallId": "call_1",
                    "toolName": "read",
                    "content": [{"type": "text", "text": "ok"}],
                    "isError": False,
                },
            ],
        )

        await runtime.sync_core_message(session["id"], message, "token", None)

        self.assertEqual(core.session["modelEvents"][0]["payload"]["content"][0]["id"], "call_1")
        self.assertEqual(core.session["modelEvents"][1]["payload"]["toolCallId"], "call_1")

    def test_ssl_eof_has_readable_runtime_summary(self):
        error = RuntimeError(
            "<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol>"
        )

        self.assertEqual(runtime_error_summary(error), "模型连接失败：安全连接被远端提前断开。")

    def test_tool_loop_keeps_each_assistant_response_as_an_independent_message(self):
        store = SessionStore()
        session = store.create_session("累计回复")
        emitter = EmitterHarness(store)
        run_state = RunState()

        for timestamp, text in ((1, "……请便。"), (2, "……请便。 莉莉安确实很擅长这种事。")):
            message = {
                "role": "assistant",
                "timestamp": timestamp,
                "provider": "provider",
                "model": "model",
                "content": [{"type": "text", "text": text}],
            }
            emitter.handle_agent_event(session["id"], {"type": "message_start", "message": message}, run_state)
            emitter.handle_agent_event(session["id"], {"type": "message_end", "message": message}, run_state)

        messages = store.list_messages(session["id"])
        visible_parts = [
            part["text"]
            for item in messages
            for part in item["parts"]
            if part["type"] == "text"
        ]
        raw_context = store.context_messages(session["id"])
        self.assertEqual(len(messages), 2)
        self.assertNotEqual(messages[0]["info"]["id"], messages[1]["info"]["id"])
        self.assertEqual(visible_parts, ["……请便。", "……请便。 莉莉安确实很擅长这种事。"])
        self.assertEqual(run_state.final_assistant_message_id, messages[1]["info"]["id"])
        self.assertEqual(raw_context[1]["content"][0]["text"], "……请便。 莉莉安确实很擅长这种事。")

    def test_runtime_trace_is_persisted_separately_from_model_messages(self):
        store = SessionStore()
        session = store.create_session("运行过程")
        emitter = EmitterHarness(store)
        run_state = RunState()

        emitter.emit_runtime_thinking(session["id"], run_state, "正在运行。")
        message = {
            "role": "assistant",
            "timestamp": 2,
            "provider": "provider",
            "model": "model",
            "content": [{"type": "text", "text": "最终回复。"}],
        }
        emitter.handle_agent_event(session["id"], {"type": "message_start", "message": message}, run_state)
        emitter.handle_agent_event(session["id"], {"type": "message_end", "message": message}, run_state)
        emitter.emit_runtime_thinking(session["id"], run_state, "完成。", done=True)

        messages = store.list_messages(session["id"])
        self.assertEqual([item["info"].get("kind") for item in messages], ["runtime", "model"])
        self.assertEqual(messages[0]["info"]["runID"], messages[1]["info"]["runID"])
        self.assertEqual(messages[0]["info"]["time"].get("completed"), messages[0]["parts"][0]["time"]["end"])
        self.assertEqual(run_state.final_assistant_message_id, messages[1]["info"]["id"])

    def test_tool_call_message_is_intermediate_and_plain_message_is_final(self):
        store = SessionStore()
        session = store.create_session("终止语义")
        emitter = EmitterHarness(store)
        run_state = RunState()
        tool_message = {
            "role": "assistant",
            "timestamp": 1,
            "content": [{"type": "toolCall", "id": "call_1", "name": "read", "arguments": {}}],
        }
        final_message = {
            "role": "assistant",
            "timestamp": 2,
            "content": [{"type": "text", "text": "读取完成。"}],
        }

        for message in (tool_message, final_message):
            emitter.handle_agent_event(session["id"], {"type": "message_start", "message": message}, run_state)
            emitter.handle_agent_event(session["id"], {"type": "message_end", "message": message}, run_state)

        messages = store.list_messages(session["id"])
        self.assertEqual(messages[0]["info"]["phase"], "tool")
        self.assertFalse(messages[0]["info"]["final"])
        self.assertEqual(messages[1]["info"]["phase"], "final")
        self.assertTrue(messages[1]["info"]["final"])
        self.assertEqual(run_state.final_assistant_message_id, messages[1]["info"]["id"])

    def test_agent_error_is_kept_on_message_and_run_state(self):
        store = SessionStore()
        session = store.create_session("错误展示")
        emitter = EmitterHarness(store)
        run_state = RunState()
        error_message = "SSL connection closed"

        emitter.handle_agent_event(
            session["id"],
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "timestamp": 1,
                    "provider": "opencode-go",
                    "model": "mimo-v2.5",
                    "content": [{"type": "text", "text": ""}],
                    "errorMessage": error_message,
                },
            },
            run_state,
        )

        message = store.list_messages(session["id"])[0]
        self.assertEqual(run_state.error_message, error_message)
        self.assertEqual(message["info"]["error"]["message"], error_message)
        self.assertFalse(any(event["type"] == "session.error" for event in emitter.events.events))

    def test_companion_speaker_and_orchestration_are_kept_on_message(self):
        store = SessionStore()
        session = store.create_session("多人编排")
        emitter = EmitterHarness(store)
        run_state = RunState(
            speaker={"assistantID": 2, "assistantName": "莉莉安", "turnIndex": 1, "beatIndex": 1},
            orchestration={
                "planID": "plan_1",
                "beatIndex": 1,
                "speechAct": "react",
                "addressTo": "assistant:1",
                "replyToBeat": 0,
            },
        )

        emitter.handle_agent_event(
            session["id"],
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "timestamp": 1,
                    "provider": "provider",
                    "model": "model",
                    "content": [{"type": "text", "text": "接住上一位助手的话。"}],
                },
            },
            run_state,
        )

        info = store.list_messages(session["id"])[0]["info"]
        self.assertEqual(info["speaker"]["assistantID"], 2)
        self.assertEqual(info["orchestration"]["planID"], "plan_1")
        self.assertEqual(info["orchestration"]["replyToBeat"], 0)

    def test_agent_events_persist_structured_tool_history_independently_from_ui_parts(self):
        store = SessionStore()
        session = store.create_session("工具历史")
        emitter = EmitterHarness(store)
        run_state = RunState()
        assistant = {
            "role": "assistant",
            "timestamp": 1,
            "provider": "provider",
            "model": "model",
            "content": [
                {"type": "thinking", "thinking": "需要读取文件"},
                {"type": "toolCall", "id": "call_read", "name": "read", "arguments": {"path": "a.txt"}},
            ],
        }
        tool_result = {
            "role": "toolResult",
            "toolCallId": "call_read",
            "toolName": "read",
            "content": [{"type": "text", "text": "文件内容"}],
            "details": {"path": "a.txt"},
            "isError": False,
            "timestamp": 2,
        }

        emitter.handle_agent_event(session["id"], {"type": "message_end", "message": assistant}, run_state)
        emitter.handle_agent_event(session["id"], {"type": "message_end", "message": tool_result}, run_state)

        context = store.context_messages(session["id"])
        self.assertEqual([message["role"] for message in context], ["assistant", "toolResult"])
        self.assertEqual(context[0]["content"][1]["id"], context[1]["toolCallId"])
        visible = store.list_messages(session["id"])[0]
        self.assertTrue(any(part["type"] == "tool" for part in visible["parts"]))


if __name__ == "__main__":
    unittest.main()
