from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import uuid
from collections import deque
from typing import Any, Awaitable, Callable

from .catalog import ConnectorCatalog, ConnectorManifest
from .protocol import MAX_PROTOCOL_LINE_BYTES


PublishEvent = Callable[[dict[str, Any]], Awaitable[None]]
ReportState = Callable[[str, str], Awaitable[None]]
logger = logging.getLogger("MonAgent.Connectors.Worker")


class ConnectorReloadRequested(RuntimeError):
    """Signals the supervisor to replace one connector worker immediately."""


class ConnectorWorkerAdapter:
    """Process-isolated proxy implementing the connector adapter contract."""

    def __init__(
        self,
        connector: dict[str, Any],
        publish: PublishEvent,
        report_state: ReportState,
        catalog: ConnectorCatalog,
        *,
        stream: bool = True,
        watch_interval: float = 0.5,
    ) -> None:
        self.connector = connector
        self.publish = publish
        self.report_state = report_state
        self.catalog = catalog
        self.manifest: ConnectorManifest = catalog.load(str(connector.get("connector_key") or ""))
        self.stream = stream
        self.watch_interval = watch_interval
        self._process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._ready = asyncio.Event()
        self._terminated = asyncio.Event()
        self._closing = False
        self._reload_requested = False
        self._fatal_message = ""
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._stdout_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._process_task: asyncio.Task[None] | None = None
        self._watch_task: asyncio.Task[None] | None = None
        self._stderr_tail: deque[str] = deque(maxlen=20)
        self.worker_pid: int | None = None

    async def _send(self, message: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.returncode is not None:
            raise RuntimeError("连接器 Worker 未运行。")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8") + b"\n"
        if len(encoded) > MAX_PROTOCOL_LINE_BYTES:
            raise RuntimeError("连接器 Worker 请求超过进程协议上限。")
        async with self._write_lock:
            process.stdin.write(encoded)
            await process.stdin.drain()

    async def _report_state_safely(self, state: str, error: str = "") -> None:
        try:
            await self.report_state(state, error)
        except Exception:
            logger.exception("连接器 %s 状态回调失败", self.manifest.key)

    async def _publish_event_with_retry(self, event: dict[str, Any]) -> bool:
        for attempt, delay in enumerate((0.0, 0.25, 0.5, 1.0, 2.0), start=1):
            if delay:
                await asyncio.sleep(delay)
            try:
                await self.publish(event)
                return True
            except Exception:
                logger.exception(
                    "连接器 %s 事件回调失败（%s/5）",
                    self.manifest.key,
                    attempt,
                )
        return False

    async def _stdout_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        while True:
            line = await process.stdout.readline()
            if not line:
                return
            if len(line) > MAX_PROTOCOL_LINE_BYTES:
                self._fatal_message = "连接器 Worker 响应超过进程协议上限。"
                return
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._fatal_message = "连接器 Worker 返回了非 JSON 输出。"
                continue
            if not isinstance(message, dict):
                continue
            message_type = message.get("type")
            if message_type == "ready":
                self.worker_pid = int(message.get("pid") or process.pid)
                self._ready.set()
            elif message_type == "state":
                await self._report_state_safely(
                    str(message.get("state") or "unknown"),
                    str(message.get("error") or ""),
                )
            elif message_type == "event" and isinstance(message.get("event"), dict):
                if not await self._publish_event_with_retry(message["event"]):
                    self._fatal_message = "连接器事件连续写入 Core 失败。"
                    if process.returncode is None:
                        process.terminate()
                    return
            elif message_type == "response":
                request_id = str(message.get("id") or "")
                waiter = self._pending.pop(request_id, None)
                if waiter is None or waiter.done():
                    continue
                if message.get("ok"):
                    waiter.set_result(message.get("result"))
                else:
                    error = message.get("error") if isinstance(message.get("error"), dict) else {}
                    waiter.set_exception(RuntimeError(str(error.get("message") or "连接器 Worker 请求失败。")))
            elif message_type == "fatal":
                error = message.get("error") if isinstance(message.get("error"), dict) else {}
                self._fatal_message = str(error.get("message") or "连接器 Worker 异常退出。")

    async def _stderr_loop(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        while True:
            line = await process.stderr.readline()
            if not line:
                return
            rendered = line.decode("utf-8", errors="replace").rstrip()
            if rendered:
                self._stderr_tail.append(rendered)
                logger.debug("[%s worker] %s", self.manifest.key, rendered)

    def _worker_error(self, return_code: int | None = None) -> RuntimeError:
        detail = self._fatal_message.strip()
        if not detail and self._stderr_tail:
            detail = self._stderr_tail[-1]
        if not detail:
            detail = f"进程退出码 {return_code}" if return_code is not None else "进程未就绪"
        return RuntimeError(f"连接器 {self.manifest.key} Worker 失败：{detail}")

    def _fail_pending(self, error: Exception) -> None:
        for waiter in self._pending.values():
            if not waiter.done():
                waiter.set_exception(error)
        self._pending.clear()

    async def _wait_process(self) -> None:
        process = self._process
        if process is None:
            return
        return_code = await process.wait()
        self._terminated.set()
        if not self._closing:
            self._fail_pending(self._worker_error(return_code))

    async def _watch_sources(self) -> None:
        consecutive_manifest_errors = 0
        while not self._closing and not self._terminated.is_set():
            await asyncio.sleep(self.watch_interval)
            try:
                current = self.catalog.load(self.manifest.key)
            except Exception as error:
                # Editors can expose an incomplete manifest briefly. Keep the
                # healthy worker for a short grace period, but a removed or
                # persistently invalid package must not run forever from stale
                # code after its contract has disappeared.
                consecutive_manifest_errors += 1
                if consecutive_manifest_errors < 4:
                    continue
                self._reload_requested = True
                await self._report_state_safely("reloading", str(error))
                try:
                    await self._send({"type": "shutdown", "reason": "manifest_unavailable"})
                except Exception:
                    process = self._process
                    if process is not None and process.returncode is None:
                        process.terminate()
                return
            consecutive_manifest_errors = 0
            if current.revision == self.manifest.revision:
                continue
            self._reload_requested = True
            await self._report_state_safely("reloading", "")
            try:
                await self._send({"type": "shutdown", "reason": "source_changed"})
            except Exception:
                process = self._process
                if process is not None and process.returncode is None:
                    process.terminate()
            return

    async def _ensure_started(self) -> None:
        async with self._start_lock:
            if self._process is not None and self._process.returncode is None and self._ready.is_set():
                return
            if self._closing:
                raise RuntimeError("连接器 Worker 已关闭。")
            self._ready.clear()
            self._terminated.clear()
            self._fatal_message = ""
            self._stderr_tail.clear()
            environment = dict(os.environ)
            environment["PYTHONUNBUFFERED"] = "1"
            cache_root = os.environ.get("XDG_RUNTIME_DIR", "").strip() or tempfile.gettempdir()
            environment["PYTHONPYCACHEPREFIX"] = os.path.join(
                cache_root,
                "monagent-connector-pycache",
                self.manifest.revision,
            )
            environment["MON_AGENT_CONNECTOR_REVISION"] = self.manifest.revision
            self._process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "mon_agent_server.connectors.worker",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=environment,
                limit=MAX_PROTOCOL_LINE_BYTES + 1024,
            )
            self._stdout_task = asyncio.create_task(self._stdout_loop(), name=f"{self.manifest.key}-worker-stdout")
            self._stderr_task = asyncio.create_task(self._stderr_loop(), name=f"{self.manifest.key}-worker-stderr")
            self._process_task = asyncio.create_task(self._wait_process(), name=f"{self.manifest.key}-worker-process")
            await self._send({
                "type": "initialize",
                "manifest": self.manifest.worker_payload(),
                "connector": self.connector,
                "stream": self.stream,
            })
            ready_task = asyncio.create_task(self._ready.wait())
            terminated_task = asyncio.create_task(self._terminated.wait())
            try:
                done, _pending = await asyncio.wait(
                    {ready_task, terminated_task},
                    timeout=10,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if ready_task not in done or not self._ready.is_set():
                    raise self._worker_error(self._process.returncode)
            finally:
                ready_task.cancel()
                terminated_task.cancel()
                await asyncio.gather(ready_task, terminated_task, return_exceptions=True)
            self._watch_task = asyncio.create_task(self._watch_sources(), name=f"{self.manifest.key}-worker-watch")

    async def _request(self, method: str, params: dict[str, Any], *, timeout: float) -> Any:
        await self._ensure_started()
        request_id = uuid.uuid4().hex
        waiter = asyncio.get_running_loop().create_future()
        self._pending[request_id] = waiter
        try:
            await self._send({"type": "request", "id": request_id, "method": method, "params": params})
            return await asyncio.wait_for(waiter, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)

    async def run(self) -> None:
        await self._ensure_started()
        await self._terminated.wait()
        if self._closing:
            return
        if self._reload_requested:
            raise ConnectorReloadRequested(f"连接器 {self.manifest.key} 源码已更新。")
        process = self._process
        raise self._worker_error(process.returncode if process is not None else None)

    async def execute(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = await self._request("execute", {"action": action, "payload": payload}, timeout=44)
        if not isinstance(result, dict):
            raise RuntimeError("连接器 Worker 动作结果不是对象。")
        return result

    async def runtime_snapshot(self) -> dict[str, Any]:
        result = await self._request("runtime_snapshot", {}, timeout=4)
        if not isinstance(result, dict):
            result = {}
        result = dict(result)
        result["worker"] = {
            "pid": self.worker_pid,
            "connector_key": self.manifest.key,
            "connector_version": self.manifest.version,
            "revision": self.manifest.revision[:16],
            "isolated": True,
        }
        return result

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        watch_task, self._watch_task = self._watch_task, None
        if watch_task is not None:
            watch_task.cancel()
            await asyncio.gather(watch_task, return_exceptions=True)
        process = self._process
        if process is not None and process.returncode is None:
            try:
                await self._send({"type": "shutdown", "reason": "parent_close"})
                await asyncio.wait_for(process.wait(), timeout=5)
            except (asyncio.TimeoutError, ConnectionError, BrokenPipeError, RuntimeError):
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=2)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
        self._terminated.set()
        self._fail_pending(RuntimeError("连接器 Worker 已关闭。"))
        tasks = [task for task in (self._stdout_task, self._stderr_task, self._process_task) if task is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._stdout_task = None
        self._stderr_task = None
        self._process_task = None
        self._process = None
