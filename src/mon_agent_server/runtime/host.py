from __future__ import annotations

import asyncio
import threading
from collections.abc import Coroutine
from concurrent.futures import Future
from typing import Any


class RuntimeHost:
    """Own one long-lived asyncio loop for root turns and background agents."""

    def __init__(self, thread_name: str = "mon-agent-runtime") -> None:
        self.thread_name = thread_name
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._lock = threading.RLock()
        self._closed = False

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and self._loop and self._loop.is_running())

    def submit(self, coroutine: Coroutine[Any, Any, Any]) -> Future[Any]:
        with self._lock:
            if self._closed:
                coroutine.close()
                raise RuntimeError("RuntimeHost is closed")
            self._ensure_started()
            assert self._loop is not None
            return asyncio.run_coroutine_threadsafe(coroutine, self._loop)

    def close(self, timeout: float = 5.0) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            loop = self._loop
            thread = self._thread
        if loop and loop.is_running():
            future = asyncio.run_coroutine_threadsafe(self._cancel_pending(), loop)
            try:
                future.result(timeout=timeout)
            except Exception:
                pass
            loop.call_soon_threadsafe(loop.stop)
        if thread and thread is not threading.current_thread():
            thread.join(timeout=timeout)

    def _ensure_started(self) -> None:
        if self.running:
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, name=self.thread_name, daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError("RuntimeHost event loop did not start")

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    @staticmethod
    async def _cancel_pending() -> None:
        current = asyncio.current_task()
        pending = [task for task in asyncio.all_tasks() if task is not current and not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
