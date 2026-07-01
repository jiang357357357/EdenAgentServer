from __future__ import annotations

import json
import queue
import threading
from typing import Any, Iterator

from .ids import now_ms


class EventBus:
    def __init__(self) -> None:
        self._clients: set[queue.Queue[str | None]] = set()
        self._lock = threading.Lock()

    def emit(self, event: dict[str, Any]) -> None:
        frame = f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            try:
                client.put_nowait(frame)
            except Exception:
                self._remove(client)

    def stream(self) -> Iterator[str]:
        client: queue.Queue[str | None] = queue.Queue()
        with self._lock:
            self._clients.add(client)
        try:
            yield self._frame({"type": "connected", "properties": {"time": now_ms()}})
            while True:
                try:
                    item = client.get(timeout=15)
                except queue.Empty:
                    yield self._frame({"type": "heartbeat", "properties": {"time": now_ms()}})
                    continue
                if item is None:
                    return
                yield item
        finally:
            self._remove(client)

    def _remove(self, client: queue.Queue[str | None]) -> None:
        with self._lock:
            self._clients.discard(client)

    @staticmethod
    def _frame(event: dict[str, Any]) -> str:
        return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
