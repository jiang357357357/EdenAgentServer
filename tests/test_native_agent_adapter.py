from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import patch

import mon_agent_server.native_runtime.client as native_client
from mon_agent_server.native_runtime import (
    NativeAgent,
    NativeAgentOptions,
    close_native_runtime,
    native_runtime_service,
    resolve_runtime_executable,
)
from mon_agent_server.tools.coding import create_all_tools


class FakeStream:
    def __init__(self, message: dict) -> None:
        self.message = message
        self.events = deque(
            [
                {"type": "start", "partial": message},
                {"type": "done", "message": message},
            ]
        )

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.events:
            raise StopAsyncIteration
        return self.events.popleft()

    async def result(self):
        return self.message


class ResettingFakeStream(FakeStream):
    def __init__(self) -> None:
        partial = {
            "role": "assistant",
            "content": [{"type": "text", "text": "partial"}],
            "provider": "fake",
            "model": "test",
            "stopReason": "stop",
            "timestamp": 2,
        }
        reset = {**partial, "content": [{"type": "text", "text": ""}]}
        final = {**partial, "content": [{"type": "text", "text": "recovered"}]}
        self.message = final
        self.events = deque(
            [
                {"type": "start", "partial": reset},
                {"type": "text_delta", "partial": partial, "delta": "partial"},
                {"type": "stream_reset", "partial": reset},
                {
                    "type": "provider_retry",
                    "attempt": 2,
                    "maxAttempts": 3,
                    "delayMs": 0,
                    "reason": "incomplete chunked read",
                    "statusCode": None,
                },
                {"type": "text_delta", "partial": final, "delta": "recovered"},
                {"type": "done", "message": final},
            ]
        )


class EchoTool:
    name = "echo"
    label = "Echo"
    description = "Echo text"
    parameters = {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }
    source = "coding"
    version = "1"
    namespace = "general"
    execution_mode = "parallel"
    exposure = "direct"
    timeout_seconds = None

    def permission_request(self, args):
        return {"permission": "echo", "patterns": [str(args.get("text") or "")]}

    async def run(self, _call_id, args, _signal, on_update):
        on_update({"content": [{"type": "text", "text": "working"}], "details": {}})
        return {
            "content": [{"type": "text", "text": str(args.get("text") or "")}],
            "details": {"tool": True},
            "success": True,
        }


class PythonReadTool:
    name = "read"
    label = "read"
    description = "Read a file"
    parameters = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }
    source = "coding"
    version = "1"
    namespace = "general"
    execution_mode = "parallel"
    exposure = "direct"
    timeout_seconds = None

    def __init__(self) -> None:
        self.run_calls = 0

    def permission_request(self, args):
        return {"permission": "read", "patterns": [str(args.get("path") or "")]}

    async def run(self, _call_id, _args, _signal, _on_update):
        self.run_calls += 1
        raise AssertionError("native read must not call the Python executor")


class PreparedPatchTool(PythonReadTool):
    name = "apply_patch"
    parameters = {
        "type": "object",
        "properties": {"patch": {"type": "string"}},
        "required": ["patch"],
        "additionalProperties": False,
    }

    @staticmethod
    def prepare_arguments(args):
        return {**args, "_paths": ["one.txt", "two.txt"]}

    def permission_request(self, args):
        return {"permission": "apply_patch", "patterns": list(args.get("_paths") or [])}


class NativeAgentAdapterTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        try:
            resolve_runtime_executable()
        except FileNotFoundError as error:
            self.skipTest(str(error))

    async def asyncTearDown(self) -> None:
        await close_native_runtime()

    def test_runtime_platform_distinguishes_supported_architectures(self) -> None:
        cases = (
            ("win32", "AMD64", "windows-x64"),
            ("win32", "ARM64", "windows-arm64"),
            ("darwin", "x86_64", "macos-x64"),
            ("darwin", "arm64", "macos-arm64"),
            ("linux", "x86_64", "linux-x64"),
            ("linux", "aarch64", "linux-arm64"),
        )
        for system, machine, expected in cases:
            with self.subTest(system=system, machine=machine):
                with (
                    patch.object(native_client.sys, "platform", system),
                    patch.object(native_client.platform, "machine", return_value=machine),
                ):
                    self.assertEqual(native_client._runtime_platform(), expected)

    async def test_initial_prompt_cache_metadata_reaches_first_model_call(self) -> None:
        contexts: list[dict] = []

        async def stream_fn(_model, context, _options):
            contexts.append(context)
            return FakeStream({
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "provider": "fake",
                "model": "test",
                "stopReason": "stop",
                "timestamp": 2,
            })

        agent = NativeAgent(NativeAgentOptions(
            session_id="cache-metadata-test",
            stream_fn=stream_fn,
            initial_state={
                "model": {"id": "test", "provider": "fake"},
                "promptCacheKey": "session-cache-key",
                "promptCacheFingerprint": "abc123",
                "promptCacheEpoch": 0,
            },
        ))
        try:
            await agent.prompt({"role": "user", "content": "go", "timestamp": 1})
        finally:
            await agent.close()

        self.assertEqual(contexts[0]["promptCacheKey"], "session-cache-key")
        self.assertEqual(contexts[0]["promptCacheFingerprint"], "abc123")
        self.assertEqual(contexts[0]["promptCacheEpoch"], 0)

    async def test_stream_reset_crosses_native_bridge_before_provider_retry(self) -> None:
        events: list[dict] = []

        async def stream_fn(_model, _context, _options):
            return ResettingFakeStream()

        agent = NativeAgent(NativeAgentOptions(
            session_id="stream-reset-test",
            stream_fn=stream_fn,
            initial_state={"model": {"id": "test", "provider": "fake"}},
        ))
        agent.subscribe(lambda event, _signal: events.append(event))
        try:
            await agent.prompt({"role": "user", "content": "go", "timestamp": 1})
        finally:
            await agent.close()

        reset_index = next(
            index
            for index, event in enumerate(events)
            if event.get("type") == "message_update"
            and (event.get("assistantMessageEvent") or {}).get("type") == "stream_reset"
        )
        retry_index = next(index for index, event in enumerate(events) if event.get("type") == "model_retry")
        self.assertLess(reset_index, retry_index)
        self.assertEqual(events[reset_index]["message"]["content"][0]["text"], "")
        self.assertEqual(agent.state.messages[-1]["content"][0]["text"], "recovered")

    async def test_runtime_crash_restarts_and_rehydrates_registered_sessions(self) -> None:
        service = native_runtime_service()
        agent = NativeAgent(NativeAgentOptions(initial_state={"model": {"id": "test"}}))
        await service.register(agent)
        process = service.client._process
        reader_task = service.client._reader_task
        self.assertIsNotNone(process)
        self.assertIsNotNone(reader_task)
        process.kill()
        await process.wait()
        await reader_task
        self.assertFalse(service.client.running)

        await service.ensure_started()
        self.assertTrue(service.client.running)
        self.assertEqual((await service.client.ping())["type"], "runtime.pong")
        closed = await service.client.close_session(agent.runtime_session_id)
        self.assertEqual(closed["type"], "session.closed")
        service._agents.pop(agent.runtime_session_id, None)

    async def test_two_sessions_run_model_callbacks_concurrently(self) -> None:
        both_started = asyncio.Event()
        started = 0

        async def stream_fn(_model, _context, _options):
            nonlocal started
            started += 1
            if started == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=1)
            return FakeStream({
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "provider": "fake",
                "model": "test",
                "stopReason": "stop",
                "timestamp": 2,
            })

        agents = [
            NativeAgent(NativeAgentOptions(
                session_id=f"concurrent-{index}",
                stream_fn=stream_fn,
                initial_state={"model": {"id": "test", "provider": "fake"}},
            ))
            for index in range(2)
        ]
        try:
            await asyncio.gather(*(
                agent.prompt({"role": "user", "content": "go", "timestamp": 1})
                for agent in agents
            ))
        finally:
            await asyncio.gather(*(agent.close() for agent in agents))
        self.assertEqual(started, 2)
        self.assertTrue(all(agent.state.messages[-1]["content"][0]["text"] == "done" for agent in agents))

    async def test_native_compaction_builds_and_finalizes_summary(self) -> None:
        service = native_runtime_service()
        await service.ensure_started()
        preparation = {
            "firstKeptEntryId": "e2",
            "messagesToSummarize": [{"role": "user", "content": "hello", "timestamp": 1}],
            "tokensBefore": 12,
            "fileOps": {"read": ["a.txt"], "written": [], "edited": []},
            "settings": {"reserveTokens": 100},
        }
        request = await service.client.build_compaction_summary_request(
            preparation,
            {"maxTokens": 40},
            "keep the path",
            None,
        )
        self.assertEqual(request["options"]["maxTokens"], 40)
        self.assertIn(
            "Additional focus: keep the path",
            request["context"]["messages"][0]["content"][0]["text"],
        )
        replay = await service.client.build_compaction_summary_request(
            preparation,
            {"maxTokens": 40},
            "keep the path",
            None,
            cache_context={"systemPrompt": "stable agent system"},
        )
        self.assertEqual(replay["context"]["systemPrompt"], "stable agent system")
        self.assertEqual(replay["context"]["messages"][0]["role"], "user")
        self.assertEqual(replay["context"]["messages"][0]["content"], "hello")
        self.assertIn(
            "Additional focus: keep the path",
            replay["context"]["messages"][-1]["content"][0]["text"],
        )
        result = await service.client.finalize_compaction(
            preparation,
            {"stopReason": "stop", "content": [{"type": "text", "text": "checkpoint"}]},
        )
        self.assertEqual(result["firstKeptEntryId"], "e2")
        self.assertEqual(result["details"]["readFiles"], ["a.txt"])
        self.assertIn("<read-files>\na.txt\n</read-files>", result["summary"])

    async def test_existing_model_tool_and_hooks_run_through_rust(self) -> None:
        model_calls = 0
        before_calls: list[dict] = []
        after_calls: list[dict] = []
        prepared_turns: list[dict] = []
        events: list[dict] = []

        async def stream_fn(_model, context, _options):
            nonlocal model_calls
            model_calls += 1
            has_tool_result = any(message.get("role") == "toolResult" for message in context["messages"])
            if not has_tool_result:
                message = {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "call_1",
                            "name": "echo",
                            "arguments": {"text": "hello"},
                        }
                    ],
                    "provider": "fake",
                    "model": "test",
                    "stopReason": "toolUse",
                    "timestamp": 2,
                }
            else:
                message = {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "finished"}],
                    "provider": "fake",
                    "model": "test",
                    "stopReason": "stop",
                    "timestamp": 4,
                }
            return FakeStream(message)

        async def before(context, _signal):
            before_calls.append(context)

        async def after(context, _signal):
            after_calls.append(context)
            return {"details": {"after": True}}

        def prepare_next(turn, _signal):
            prepared_turns.append(turn)

        agent = NativeAgent(
            NativeAgentOptions(
                session_id="adapter-test",
                stream_fn=stream_fn,
                before_tool_call=before,
                after_tool_call=after,
                prepare_next_turn_with_context=prepare_next,
                initial_state={
                    "model": {"id": "test", "provider": "fake", "api": "fake"},
                    "systemPrompt": "test",
                    "messages": [],
                    "tools": [EchoTool()],
                },
            )
        )
        agent.subscribe(lambda event, _signal: events.append(event))
        try:
            await agent.prompt({"role": "user", "content": "go", "timestamp": 1})
        finally:
            await agent.close()

        self.assertEqual(model_calls, 2)
        self.assertEqual(agent.state.messages[-1]["content"][0]["text"], "finished")
        self.assertEqual(before_calls[0]["permissionRequest"]["permission"], "echo")
        self.assertEqual(after_calls[0]["result"]["details"], {"tool": True})
        self.assertEqual(len(prepared_turns), 2)
        self.assertTrue(any(event.get("type") == "tool_execution_update" for event in events))
        tool_end = next(event for event in events if event.get("type") == "tool_execution_end")
        self.assertEqual(tool_end["result"]["details"], {"after": True})

    async def test_native_read_bypasses_python_executor_and_keeps_permission_hook(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "native.txt").write_text("from rust", encoding="utf-8")
            read_tool = PythonReadTool()
            permission_requests: list[dict] = []
            model_calls = 0

            async def stream_fn(_model, context, _options):
                nonlocal model_calls
                model_calls += 1
                result = next(
                    (message for message in context["messages"] if message.get("role") == "toolResult"),
                    None,
                )
                if result is None:
                    message = {
                        "role": "assistant",
                        "content": [{
                            "type": "toolCall",
                            "id": "native_read_1",
                            "name": "read",
                            "arguments": {"path": "native.txt"},
                        }],
                        "provider": "fake",
                        "model": "test",
                        "stopReason": "toolUse",
                        "timestamp": 2,
                    }
                else:
                    self.assertEqual(result["content"][0]["text"], "from rust")
                    message = {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "done"}],
                        "provider": "fake",
                        "model": "test",
                        "stopReason": "stop",
                        "timestamp": 4,
                    }
                return FakeStream(message)

            async def before(payload, _signal):
                permission_requests.append(payload["permissionRequest"])

            agent = NativeAgent(
                NativeAgentOptions(
                    session_id="native-read-test",
                    workspace_root=directory,
                    stream_fn=stream_fn,
                    before_tool_call=before,
                    initial_state={
                        "model": {"id": "test", "provider": "fake", "api": "fake"},
                        "tools": [read_tool],
                    },
                )
            )
            try:
                await agent.prompt({"role": "user", "content": "read it", "timestamp": 1})
            finally:
                await agent.close()

            self.assertEqual(model_calls, 2)
            self.assertEqual(read_tool.run_calls, 0)
            self.assertEqual(permission_requests, [{"permission": "read", "patterns": ["native.txt"]}])

    async def test_get_diff_executes_in_rust_and_returns_structured_patch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            def git(*arguments: str) -> None:
                subprocess.run(
                    ["git", *arguments], cwd=directory, check=True,
                    capture_output=True, text=True,
                )

            git("init", "-q")
            git("config", "user.email", "tests@monagent.local")
            git("config", "user.name", "MonAgent Tests")
            Path(directory, "tracked.txt").write_text("before\n", encoding="utf-8")
            git("add", "tracked.txt")
            git("commit", "-qm", "fixture")
            Path(directory, "tracked.txt").write_text("after\n", encoding="utf-8")
            get_diff = create_all_tools(directory)["get_diff"]

            async def stream_fn(_model, context, _options):
                result = next(
                    (message for message in context["messages"] if message.get("role") == "toolResult"),
                    None,
                )
                if result is None:
                    message = {
                        "role": "assistant",
                        "content": [{
                            "type": "toolCall", "id": "diff_1", "name": "get_diff",
                            "arguments": {"scope": "working_tree", "path": "."},
                        }],
                        "provider": "fake", "model": "test", "stopReason": "toolUse", "timestamp": 2,
                    }
                else:
                    self.assertEqual(result["details"]["kind"], "workspace_diff")
                    self.assertIn("tracked.txt", result["details"]["patch"])
                    message = {
                        "role": "assistant", "content": [{"type": "text", "text": "reviewed"}],
                        "provider": "fake", "model": "test", "stopReason": "stop", "timestamp": 4,
                    }
                return FakeStream(message)

            agent = NativeAgent(NativeAgentOptions(
                session_id="native-diff-test", workspace_root=directory, stream_fn=stream_fn,
                initial_state={"model": {"id": "test", "provider": "fake"}, "tools": [get_diff]},
            ))
            try:
                await agent.prompt({"role": "user", "content": "review", "timestamp": 1})
            finally:
                await agent.close()
            self.assertEqual(agent.state.messages[-1]["content"][0]["text"], "reviewed")

    @unittest.skipUnless(sys.platform == "win32", "requires Windows PowerShell")
    async def test_powershell_executes_directly_in_rust_with_utf8_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            powershell = create_all_tools(directory)["powershell"]

            async def stream_fn(_model, context, _options):
                result = next(
                    (message for message in context["messages"] if message.get("role") == "toolResult"),
                    None,
                )
                if result is None:
                    message = {
                        "role": "assistant",
                        "content": [{
                            "type": "toolCall",
                            "id": "powershell_1",
                            "name": "powershell",
                            "arguments": {
                                "command": "$value = [pscustomobject]@{ Used = 3 }; $value | ForEach-Object { Write-Output (\"值=$($_.Used) 中文\") }",
                            },
                        }],
                        "provider": "fake",
                        "model": "test",
                        "stopReason": "toolUse",
                        "timestamp": 2,
                    }
                else:
                    self.assertEqual(result["content"][0]["text"].strip(), "值=3 中文")
                    self.assertEqual(result["details"]["launcher"], "powershell")
                    message = {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "verified"}],
                        "provider": "fake",
                        "model": "test",
                        "stopReason": "stop",
                        "timestamp": 4,
                    }
                return FakeStream(message)

            agent = NativeAgent(NativeAgentOptions(
                session_id="native-powershell-test",
                workspace_root=directory,
                stream_fn=stream_fn,
                initial_state={"model": {"id": "test", "provider": "fake"}, "tools": [powershell]},
            ))
            try:
                await agent.prompt({"role": "user", "content": "inspect Windows", "timestamp": 1})
            finally:
                await agent.close()
            self.assertEqual(agent.state.messages[-1]["content"][0]["text"], "verified")

    async def test_prepared_internal_arguments_only_feed_permission_resolution(self) -> None:
        tool = PreparedPatchTool()
        before_calls: list[dict] = []

        async def before(payload, _signal):
            before_calls.append(payload)

        agent = NativeAgent(
            NativeAgentOptions(
                before_tool_call=before,
                initial_state={"tools": [tool]},
            )
        )
        message = agent._prepare_assistant_tool_calls({
            "role": "assistant",
            "content": [{
                "type": "toolCall",
                "id": "patch-1",
                "name": "apply_patch",
                "arguments": {"patch": "*** Begin Patch\n*** End Patch"},
            }],
        })
        self.assertNotIn("_paths", message["content"][0]["arguments"])
        await agent._hook_callback({
            "hook": "beforeToolCall",
            "payload": {
                "toolCall": message["content"][0],
                "args": message["content"][0]["arguments"],
            },
        })
        self.assertEqual(before_calls[0]["permissionRequest"]["patterns"], ["one.txt", "two.txt"])
        self.assertEqual(before_calls[0]["args"]["_paths"], ["one.txt", "two.txt"])


if __name__ == "__main__":
    unittest.main()
