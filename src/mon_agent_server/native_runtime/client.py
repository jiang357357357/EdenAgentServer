from __future__ import annotations

import asyncio
import inspect
import json
import os
import platform
import sys
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 8 * 1024 * 1024
REQUIRED_CAPABILITIES = frozenset(
    {
        "session.control",
        "agent.turn",
        "model.callback",
        "tool.callback",
        "native.fs-tools",
        "native.process-tools",
        "native.compaction",
        "native.session-context",
        "native.skills",
        "native.multi-agent",
    }
)

Frame = dict[str, Any]
ModelUpdate = Callable[..., Awaitable[None]]
ToolUpdate = Callable[[Frame], Awaitable[None]]
ModelCallback = Callable[[Frame, ModelUpdate], Awaitable[Frame]]
ToolCallback = Callable[[Frame, ToolUpdate], Awaitable[Frame]]
HookCallback = Callable[[Frame], Awaitable[Any]]
EventCallback = Callable[[Frame], Awaitable[None] | None]


class NativeRuntimeError(RuntimeError):
    pass


class NativeRuntimeProtocolError(NativeRuntimeError):
    pass


@dataclass(slots=True)
class NativeTurn:
    request_id: str
    session_id: str
    _completion: asyncio.Future[Frame]

    async def wait(self) -> Frame:
        return await asyncio.shield(self._completion)


def resolve_runtime_executable() -> Path:
    configured = os.environ.get("MON_AGENT_RUNTIME_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"MON_AGENT_RUNTIME_PATH does not exist: {path}")
        return path

    executable = "mon-agent-runtime.exe" if sys.platform == "win32" else "mon-agent-runtime"
    server_root = Path(__file__).resolve().parents[3]
    candidates = (
        server_root / "bin" / _runtime_platform() / executable,
        server_root.parent / "AgentCore" / "target" / "release" / executable,
        server_root.parent / "AgentCore" / "target" / "debug" / executable,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    searched = "\n".join(f"- {path}" for path in candidates)
    raise FileNotFoundError(
        "mon-agent-runtime was not found. Build AgentCore or set "
        f"MON_AGENT_RUNTIME_PATH. Searched:\n{searched}"
    )


def _runtime_platform() -> str:
    machine = platform.machine().lower()
    is_arm64 = machine in {"arm64", "aarch64"}
    if sys.platform == "win32":
        return "windows-arm64" if is_arm64 else "windows-x64"
    if sys.platform == "darwin":
        return "macos-arm64" if is_arm64 else "macos-x64"
    return "linux-arm64" if is_arm64 else "linux-x64"


class NativeRuntimeClient:
    """Async owner for one Rust AgentCore sidecar process."""

    def __init__(
        self,
        *,
        command: Sequence[str] | None = None,
        server_version: str = "dev",
        model_callback: ModelCallback | None = None,
        tool_callback: ToolCallback | None = None,
        hook_callback: HookCallback | None = None,
        event_callback: EventCallback | None = None,
        stderr_callback: EventCallback | None = None,
        required_capabilities: frozenset[str] = REQUIRED_CAPABILITIES,
    ) -> None:
        self.command = tuple(command) if command else None
        self.server_version = server_version
        self.model_callback = model_callback
        self.tool_callback = tool_callback
        self.hook_callback = hook_callback
        self.event_callback = event_callback
        self.stderr_callback = stderr_callback
        self.required_capabilities = required_capabilities
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._callback_tasks: set[asyncio.Task[None]] = set()
        self._pending: dict[str, asyncio.Future[Frame]] = {}
        self._turns: dict[str, asyncio.Future[Frame]] = {}
        self._write_lock = asyncio.Lock()
        self._closed = False
        self.capabilities: frozenset[str] = frozenset()
        self.runtime_version = ""

    @property
    def running(self) -> bool:
        return bool(
            self._process
            and self._process.returncode is None
            and self._reader_task
            and not self._reader_task.done()
        )

    async def start(self) -> Frame:
        if self.running:
            raise NativeRuntimeError("native runtime is already running")
        if self._closed:
            raise NativeRuntimeError("native runtime client is closed")
        if self._process is not None:
            await self._stop_process()
        command = self.command or (str(resolve_runtime_executable()), "--transport=stdio")
        self._process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=MAX_FRAME_BYTES + 1,
        )
        self._reader_task = asyncio.create_task(self._read_stdout(), name="native-agent-runtime:stdout")
        self._stderr_task = asyncio.create_task(self._read_stderr(), name="native-agent-runtime:stderr")
        try:
            response = await self._request(
                {
                    "type": "runtime.initialize",
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverVersion": self.server_version,
                }
            )
        except BaseException:
            await self._stop_process()
            raise
        if response.get("protocolVersion") != PROTOCOL_VERSION:
            await self.close()
            raise NativeRuntimeProtocolError(
                f"runtime selected protocol {response.get('protocolVersion')!r}, expected {PROTOCOL_VERSION}"
            )
        self.runtime_version = str(response.get("runtimeVersion") or "")
        self.capabilities = frozenset(str(item) for item in response.get("capabilities") or [])
        missing = self.required_capabilities - self.capabilities
        if missing:
            await self.close()
            raise NativeRuntimeProtocolError(
                "runtime is missing required capabilities: " + ", ".join(sorted(missing))
            )
        return response

    async def create_session(self, session_id: str, config: Frame) -> Frame:
        return await self._request(
            {"type": "session.create", "sessionID": session_id, "config": config}
        )

    async def close_session(self, session_id: str) -> Frame:
        return await self._request({"type": "session.close", "sessionID": session_id})

    async def start_turn(self, session_id: str, prompts: list[Frame]) -> NativeTurn:
        request_id = self._request_id()
        loop = asyncio.get_running_loop()
        completion: asyncio.Future[Frame] = loop.create_future()
        self._turns[request_id] = completion
        try:
            await self._request(
                {
                    "type": "turn.start",
                    "requestID": request_id,
                    "sessionID": session_id,
                    "prompts": prompts,
                }
            )
        except BaseException:
            self._turns.pop(request_id, None)
            if not completion.done():
                completion.cancel()
            raise
        return NativeTurn(request_id, session_id, completion)

    async def cancel_turn(self, session_id: str) -> Frame:
        return await self._request({"type": "turn.cancel", "sessionID": session_id})

    async def steer(self, session_id: str, message: Frame) -> Frame:
        return await self._request(
            {"type": "turn.steer", "sessionID": session_id, "message": message}
        )

    async def follow_up(self, session_id: str, message: Frame) -> Frame:
        return await self._request(
            {"type": "turn.followUp", "sessionID": session_id, "message": message}
        )

    async def ping(self) -> Frame:
        return await self._request({"type": "runtime.ping"})

    async def estimate_context_tokens(
        self,
        messages: list[Frame],
        model_id: str | None = None,
    ) -> Frame:
        response = await self._request(
            {"type": "context.estimate", "messages": messages, "modelID": model_id}
        )
        return dict(response.get("estimate") or {})

    async def prepare_compaction(
        self,
        entries: list[Frame],
        settings: Frame,
        model_id: str | None = None,
    ) -> Frame | None:
        response = await self._request(
            {
                "type": "compaction.prepare",
                "entries": entries,
                "settings": settings,
                "modelID": model_id,
            }
        )
        preparation = response.get("preparation")
        return dict(preparation) if isinstance(preparation, dict) else None

    async def build_compaction_summary_request(
        self,
        preparation: Frame,
        model: Frame,
        custom_instructions: str | None = None,
        thinking_level: str | None = None,
        cache_context: Frame | None = None,
    ) -> Frame:
        response = await self._request(
            {
                "type": "compaction.buildSummaryRequest",
                "preparation": preparation,
                "model": model,
                "cacheContext": cache_context,
                "customInstructions": custom_instructions,
                "thinkingLevel": thinking_level,
            }
        )
        return dict(response.get("request") or {})

    async def finalize_compaction(self, preparation: Frame, response: Frame) -> Frame:
        result = await self._request(
            {
                "type": "compaction.finalize",
                "preparation": preparation,
                "response": response,
            }
        )
        return dict(result.get("compaction") or {})

    async def build_session_context(self, entries: list[Frame]) -> Frame:
        response = await self._request({"type": "session.context", "entries": entries})
        return dict(response.get("context") or {})

    async def load_skills(self, directories: list[str]) -> Frame:
        response = await self._request({"type": "skills.load", "directories": directories})
        return dict(response.get("result") or {})

    async def agent_control(
        self,
        root_session_id: str,
        action: str,
        payload: Frame | None = None,
    ) -> Frame:
        response = await self._request(
            {
                "type": "agent.control",
                "rootSessionID": root_session_id,
                "action": action,
                "payload": payload or {},
            }
        )
        result = response.get("result")
        return dict(result) if isinstance(result, dict) else {"value": result}

    async def close(self, timeout: float = 5.0) -> None:
        if self._closed:
            return
        self._closed = True
        process = self._process
        if process and process.returncode is None:
            try:
                await asyncio.wait_for(self._request({"type": "runtime.shutdown"}), timeout=timeout)
            except Exception:
                pass
        await self._stop_process(timeout)

    async def _request(self, frame: Frame) -> Frame:
        if not self._process or self._process.returncode is not None or not self._process.stdin:
            raise NativeRuntimeError("native runtime is not running")
        request_id = str(frame.get("requestID") or self._request_id())
        payload = {**frame, "requestID": request_id}
        loop = asyncio.get_running_loop()
        response: asyncio.Future[Frame] = loop.create_future()
        if request_id in self._pending:
            raise NativeRuntimeProtocolError(f"duplicate requestID: {request_id}")
        self._pending[request_id] = response
        try:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_FRAME_BYTES:
                raise NativeRuntimeProtocolError(f"request exceeds {MAX_FRAME_BYTES} bytes")
            async with self._write_lock:
                self._process.stdin.write(encoded + b"\n")
                await self._process.stdin.drain()
            return await asyncio.shield(response)
        finally:
            self._pending.pop(request_id, None)

    async def _read_stdout(self) -> None:
        assert self._process and self._process.stdout
        failure: BaseException | None = None
        cancelled = False
        try:
            while line := await self._process.stdout.readline():
                if len(line) > MAX_FRAME_BYTES + 1:
                    raise NativeRuntimeProtocolError("runtime response frame is too large")
                try:
                    frame = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise NativeRuntimeProtocolError(f"runtime emitted invalid JSON: {error}") from error
                if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
                    raise NativeRuntimeProtocolError("runtime emitted a non-object frame or omitted type")
                await self._dispatch(frame)
        except asyncio.CancelledError:
            cancelled = True
            if self._process.returncode is None:
                self._process.terminate()
            raise
        except BaseException as error:
            failure = error
        finally:
            if failure is None and not self._closed and not cancelled:
                code = await self._process.wait()
                failure = NativeRuntimeError(f"native runtime exited unexpectedly with code {code}")
            if failure is not None:
                self._fail_waiters(failure)

    async def _dispatch(self, frame: Frame) -> None:
        frame_type = frame["type"]
        if frame_type == "turn.event":
            await self._emit(self.event_callback, frame)
            return
        if frame_type == "turn.completed":
            request_id = str(frame.get("requestID") or "")
            completion = self._turns.pop(request_id, None)
            if completion and not completion.done():
                completion.set_result(frame)
            return
        if frame_type in {"model.call", "tool.call", "hook.call"}:
            task = asyncio.create_task(self._run_callback(frame), name=f"native-agent-runtime:{frame_type}")
            self._callback_tasks.add(task)
            task.add_done_callback(self._callback_tasks.discard)
            return

        request_id = str(frame.get("requestID") or "")
        pending = self._pending.get(request_id)
        if frame_type == "runtime.error" and not pending:
            turn = self._turns.pop(request_id, None)
            if turn and not turn.done():
                turn.set_exception(
                    NativeRuntimeError(
                        f"{frame.get('code') or 'runtime_error'}: {frame.get('message') or 'unknown runtime error'}"
                    )
                )
                return
        if not pending or pending.done():
            raise NativeRuntimeProtocolError(f"unexpected response for requestID {request_id!r}")
        if frame_type == "runtime.error":
            pending.set_exception(
                NativeRuntimeError(
                    f"{frame.get('code') or 'runtime_error'}: {frame.get('message') or 'unknown runtime error'}"
                )
            )
        else:
            pending.set_result(frame)

    async def _run_callback(self, frame: Frame) -> None:
        operation_id = str(frame.get("operationID") or "")
        frame_type = frame["type"]
        try:
            if frame_type == "model.call":
                if self.model_callback is None:
                    raise NativeRuntimeError("Server has no model callback configured")

                async def model_update(
                    message: Frame,
                    delta: str = "",
                    event: Frame | None = None,
                ) -> None:
                    await self._request(
                        {
                            "type": "model.update",
                            "operationID": operation_id,
                            "message": message,
                            "delta": delta,
                            "event": event,
                        }
                    )

                result = await self.model_callback(frame, model_update)
                await self._request(
                    {"type": "model.result", "operationID": operation_id, "message": result}
                )
            elif frame_type == "tool.call":
                if self.tool_callback is None:
                    raise NativeRuntimeError("Server has no tool callback configured")

                async def tool_update(result: Frame) -> None:
                    await self._request(
                        {"type": "tool.update", "operationID": operation_id, "result": result}
                    )

                result = await self.tool_callback(frame, tool_update)
                await self._request(
                    {"type": "tool.result", "operationID": operation_id, "result": result}
                )
            else:
                if self.hook_callback is None:
                    raise NativeRuntimeError("Server has no hook callback configured")
                result = await self.hook_callback(frame)
                await self._request(
                    {"type": "hook.result", "operationID": operation_id, "result": result}
                )
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            kind = frame_type.split(".", 1)[0]
            try:
                await self._request(
                    {
                        "type": f"{kind}.result",
                        "operationID": operation_id,
                        "error": {
                            "code": type(error).__name__,
                            "message": str(error),
                            "retryable": False,
                        },
                    }
                )
            except Exception:
                return

    async def _read_stderr(self) -> None:
        assert self._process and self._process.stderr
        while line := await self._process.stderr.readline():
            text = line.decode("utf-8", errors="replace").rstrip("\r\n")
            await self._emit(self.stderr_callback, {"type": "runtime.stderr", "message": text})

    async def _stop_process(self, timeout: float = 5.0) -> None:
        process = self._process
        if process and process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=max(0.0, timeout))
            except TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        current = asyncio.current_task()
        tasks = [
            task
            for task in (self._reader_task, self._stderr_task, *self._callback_tasks)
            if task and task is not current and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._process = None
        self._reader_task = None
        self._stderr_task = None
        self._fail_waiters(NativeRuntimeError("native runtime closed"))

    def _fail_waiters(self, error: BaseException) -> None:
        for future in (*self._pending.values(), *self._turns.values()):
            if not future.done():
                future.set_exception(error)
        self._turns.clear()

    @staticmethod
    async def _emit(callback: EventCallback | None, frame: Frame) -> None:
        if callback is None:
            return
        result = callback(frame)
        if inspect.isawaitable(result):
            await result

    @staticmethod
    def _request_id() -> str:
        return f"req_{uuid.uuid4().hex}"
