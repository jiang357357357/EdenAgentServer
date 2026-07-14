import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from mon_agent_server.runtime import MonAgentRuntime
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


if __name__ == "__main__":
    unittest.main()
