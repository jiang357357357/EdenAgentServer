from __future__ import annotations

import asyncio
import sys
import textwrap
import unittest

from mon_agent_server.native_runtime import NativeRuntimeClient

FAKE_RUNTIME = textwrap.dedent(
    r"""
    import json
    import sys

    turn_id = None
    for line in sys.stdin:
        request = json.loads(line)
        kind = request["type"]
        request_id = request["requestID"]
        if kind == "runtime.initialize":
            response = {"type": "runtime.initialized", "requestID": request_id, "protocolVersion": 1, "runtimeVersion": "test", "capabilities": ["session.control", "agent.turn", "model.callback", "tool.callback", "native.fs-tools", "native.process-tools", "native.compaction", "native.session-context", "native.skills", "native.multi-agent"]}
        elif kind == "session.create":
            response = {"type": "session.created", "requestID": request_id, "sessionID": request["sessionID"]}
        elif kind == "context.estimate":
            response = {"type": "context.estimated", "requestID": request_id, "estimate": {"tokens": 1, "usageTokens": 0, "trailingTokens": 1, "lastUsageIndex": None}}
        elif kind == "compaction.prepare":
            response = {"type": "compaction.prepared", "requestID": request_id, "preparation": None}
        elif kind == "compaction.buildSummaryRequest":
            response = {"type": "compaction.summaryRequestBuilt", "requestID": request_id, "request": {"context": {"systemPrompt": "summarize", "messages": []}, "options": {"maxTokens": 10}}}
        elif kind == "compaction.finalize":
            response = {"type": "compaction.finalized", "requestID": request_id, "compaction": {"summary": "done", "firstKeptEntryId": "e1", "tokensBefore": 2, "details": {}}}
        elif kind == "session.context":
            response = {"type": "session.contextBuilt", "requestID": request_id, "context": {"messages": [], "thinkingLevel": "off", "model": None, "activeToolNames": None}}
        elif kind == "skills.load":
            response = {"type": "skills.loaded", "requestID": request_id, "result": {"skills": [], "diagnostics": []}}
        elif kind == "agent.control":
            response = {"type": "agent.controlled", "requestID": request_id, "result": {"created": True}}
        elif kind == "turn.start":
            turn_id = request_id
            print(json.dumps({"type": "turn.started", "requestID": request_id, "sessionID": request["sessionID"]}), flush=True)
            print(json.dumps({"type": "turn.event", "requestID": request_id, "sessionID": request["sessionID"], "event": {"type": "agent_start"}}), flush=True)
            response = {"type": "model.call", "operationID": "model_1", "sessionID": request["sessionID"], "model": {"id": "test", "provider": "fake"}, "systemPrompt": "", "messages": request["prompts"], "tools": [], "metadata": {}}
        elif kind == "model.result":
            print(json.dumps({"type": "runtime.accepted", "requestID": request_id}), flush=True)
            response = {"type": "turn.completed", "requestID": turn_id, "sessionID": "s1", "newMessages": [request["message"]], "context": {"systemPrompt": "", "messages": [request["message"]], "metadata": {}}, "turns": 1}
        elif kind == "runtime.shutdown":
            response = {"type": "runtime.shutdownComplete", "requestID": request_id}
            print(json.dumps(response), flush=True)
            break
        else:
            response = {"type": "runtime.error", "requestID": request_id, "code": "unsupported", "message": kind}
        print(json.dumps(response), flush=True)
    """
)


class NativeRuntimeClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_model_callback_and_turn_completion(self) -> None:
        events: list[dict] = []

        async def model_callback(_frame, update):
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": "native reply"}],
                "provider": "fake",
                "model": "test",
                "stopReason": "stop",
                "timestamp": 2,
            }
            await update(message, "native reply")
            return message

        # The fake runtime does not implement model.update; keep this test focused
        # on the callback completion path.
        async def model_callback_without_update(frame, _update):
            return await model_callback(frame, lambda *_args: asyncio.sleep(0))

        client = NativeRuntimeClient(
            command=(sys.executable, "-u", "-c", FAKE_RUNTIME),
            server_version="test",
            model_callback=model_callback_without_update,
            event_callback=events.append,
        )
        try:
            initialized = await client.start()
            self.assertEqual(initialized["runtimeVersion"], "test")
            estimate = await client.estimate_context_tokens(
                [{"role": "user", "content": "hello", "timestamp": 1}],
                "gpt-4o",
            )
            self.assertEqual(estimate["tokens"], 1)
            self.assertIsNone(await client.prepare_compaction([], {}, "gpt-4o"))
            summary_request = await client.build_compaction_summary_request({}, {}, None, None)
            self.assertEqual(summary_request["options"]["maxTokens"], 10)
            compaction = await client.finalize_compaction({}, {"content": []})
            self.assertEqual(compaction["summary"], "done")
            context = await client.build_session_context([])
            self.assertEqual(context["thinkingLevel"], "off")
            skills = await client.load_skills([])
            self.assertEqual(skills["skills"], [])
            control = await client.agent_control("s1", "create", {})
            self.assertTrue(control["created"])
            await client.create_session(
                "s1",
                {
                    "model": {"id": "test", "provider": "fake"},
                    "messages": [],
                    "tools": [],
                    "metadata": {},
                },
            )
            turn = await client.start_turn(
                "s1",
                [{"role": "user", "content": "hello", "timestamp": 1}],
            )
            completed = await asyncio.wait_for(turn.wait(), timeout=2)
            self.assertEqual(completed["newMessages"][0]["content"][0]["text"], "native reply")
            self.assertEqual(events[0]["event"]["type"], "agent_start")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
