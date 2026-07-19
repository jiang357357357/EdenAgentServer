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

    def test_ssl_eof_has_readable_runtime_summary(self):
        error = RuntimeError(
            "<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol>"
        )

        self.assertEqual(runtime_error_summary(error), "模型连接失败：安全连接被远端提前断开。")

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


if __name__ == "__main__":
    unittest.main()
