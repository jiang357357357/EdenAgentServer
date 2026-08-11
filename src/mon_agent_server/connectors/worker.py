from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import sys
import traceback
from typing import Any

from .protocol import MAX_PROTOCOL_LINE_BYTES

class _Emitter:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        # Keep a private handle to the protocol stream. Adapter code is allowed
        # to print diagnostics, so worker startup redirects ordinary stdout to
        # stderr before importing the adapter and cannot corrupt NDJSON RPC.
        self._stream = sys.stdout.buffer

    async def send(self, message: dict[str, Any]) -> None:
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8") + b"\n"
        if len(encoded) > MAX_PROTOCOL_LINE_BYTES:
            raise RuntimeError("连接器 Worker 响应超过进程协议上限。")
        async with self._lock:
            self._stream.write(encoded)
            self._stream.flush()


async def _read_message() -> dict[str, Any] | None:
    line = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_PROTOCOL_LINE_BYTES + 1)
    if not line:
        return None
    if len(line) > MAX_PROTOCOL_LINE_BYTES or not line.endswith(b"\n"):
        raise RuntimeError("连接器 Worker 请求超过进程协议上限。")
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise RuntimeError("连接器 Worker 收到无效 JSON。") from error
    if not isinstance(value, dict):
        raise RuntimeError("连接器 Worker 请求必须是对象。")
    return value


def _load_adapter(specification: str) -> type[Any]:
    module_name, separator, attribute_path = specification.partition(":")
    if not separator or not module_name or not attribute_path:
        raise RuntimeError("连接器 adapter 必须是 module:Class。")
    module = importlib.import_module(module_name)
    current: Any = module
    for name in attribute_path.split("."):
        current = getattr(current, name)
    if not inspect.isclass(current):
        raise RuntimeError(f"连接器 adapter 不是类：{specification}。")
    return current


class ConnectorWorker:
    def __init__(self, initialization: dict[str, Any], emitter: _Emitter) -> None:
        manifest = initialization.get("manifest")
        connector = initialization.get("connector")
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
            raise RuntimeError("连接器 Worker 缺少有效清单。")
        if not isinstance(connector, dict):
            raise RuntimeError("连接器 Worker 缺少连接器配置。")
        self.manifest = manifest
        self.connector = connector
        self.stream = bool(initialization.get("stream"))
        self.emitter = emitter
        self._adapter: Any | None = None
        self._stream_task: asyncio.Task[Any] | None = None
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._execute_lock = asyncio.Lock()
        self._closing = False

    async def _publish(self, event: dict[str, Any]) -> None:
        await self.emitter.send({"type": "event", "event": event})

    async def _report(self, state: str, error: str = "") -> None:
        await self.emitter.send({"type": "state", "state": state, "error": error})

    async def start(self) -> None:
        sys.stdout = sys.stderr
        adapter_type = _load_adapter(str(self.manifest.get("adapter") or ""))
        self._adapter = adapter_type(self.connector, self._publish, self._report)
        if self.stream:
            self._stream_task = asyncio.create_task(self._adapter.run(), name="connector-stream")
        await self.emitter.send({
            "type": "ready",
            "connectorKey": self.manifest.get("key"),
            "connectorVersion": self.manifest.get("version"),
            "revision": self.manifest.get("revision"),
            "pid": __import__("os").getpid(),
        })

    async def _execute_request(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        try:
            if self._adapter is None:
                raise RuntimeError("连接器 Worker 尚未初始化。")
            if method == "execute":
                action = str(params.get("action") or "")
                payload = params.get("payload") if isinstance(params.get("payload"), dict) else {}
                async with self._execute_lock:
                    result = await self._adapter.execute(action, payload)
            elif method == "runtime_snapshot":
                snapshot = getattr(self._adapter, "runtime_snapshot", None)
                if not callable(snapshot):
                    result = {}
                else:
                    result = snapshot()
                    if inspect.isawaitable(result):
                        result = await result
                    if not isinstance(result, dict):
                        result = {}
            else:
                raise RuntimeError(f"连接器 Worker 不支持方法 {method or '(empty)'}。")
            await self.emitter.send({"type": "response", "id": request_id, "ok": True, "result": result})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            await self.emitter.send({
                "type": "response",
                "id": request_id,
                "ok": False,
                "error": {"type": type(error).__name__, "message": str(error)},
            })

    async def command_loop(self) -> None:
        while not self._closing:
            message = await _read_message()
            if message is None or message.get("type") == "shutdown":
                return
            if message.get("type") != "request":
                continue
            request_id = str(message.get("id") or "")
            method = str(message.get("method") or "")
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            if not request_id:
                continue
            task = asyncio.create_task(self._execute_request(request_id, method, params))
            self._request_tasks.add(task)
            task.add_done_callback(self._request_tasks.discard)

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        tasks = list(self._request_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._request_tasks.clear()
        if self._stream_task is not None:
            self._stream_task.cancel()
            await asyncio.gather(self._stream_task, return_exceptions=True)
            self._stream_task = None
        if self._adapter is not None:
            await self._adapter.close()
            self._adapter = None


async def _main() -> int:
    emitter = _Emitter()
    try:
        initialization = await _read_message()
        if initialization is None or initialization.get("type") != "initialize":
            raise RuntimeError("连接器 Worker 的第一条消息必须是 initialize。")
        worker = ConnectorWorker(initialization, emitter)
        await worker.start()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        try:
            await emitter.send({"type": "fatal", "error": {"type": type(error).__name__, "message": str(error)}})
        except Exception:
            pass
        return 1

    command_task = asyncio.create_task(worker.command_loop(), name="connector-command-loop")
    try:
        wait_for: set[asyncio.Task[Any]] = {command_task}
        if worker._stream_task is not None:
            wait_for.add(worker._stream_task)
        done, _pending = await asyncio.wait(wait_for, return_when=asyncio.FIRST_COMPLETED)
        if worker._stream_task is not None and worker._stream_task in done and not worker._closing:
            error = worker._stream_task.exception()
            message = str(error) if error is not None else "远端事件流已结束。"
            await emitter.send({"type": "fatal", "error": {"type": type(error).__name__ if error else "RuntimeError", "message": message}})
            return 1
        return 0
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        try:
            await emitter.send({"type": "fatal", "error": {"type": type(error).__name__, "message": str(error)}})
        except Exception:
            pass
        return 1
    finally:
        command_task.cancel()
        await asyncio.gather(command_task, return_exceptions=True)
        await worker.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
