from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from .events import EventBus
from .ids import create_id

PermissionReply = str


@dataclass(slots=True)
class _PermissionWaiter:
    request: dict[str, Any]
    event: threading.Event
    reply: str | None = None


class PermissionBroker:
    def __init__(self, events: EventBus) -> None:
        self._events = events
        self._waiters: dict[str, _PermissionWaiter] = {}
        self._always_allowed: set[str] = set()
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [waiter.request for waiter in self._waiters.values()]

    def is_always_allowed(self, permission: str, pattern: str) -> bool:
        return f"{permission}:{pattern}" in self._always_allowed or f"{permission}:*" in self._always_allowed

    def ask(self, request: dict[str, Any]) -> str:
        request_id = create_id("per")
        full_request = {**request, "id": request_id, "always": request.get("always") or []}
        waiter = _PermissionWaiter(full_request, threading.Event())
        with self._lock:
            self._waiters[request_id] = waiter
        self._events.emit({"type": "permission.asked", "properties": full_request})
        waiter.event.wait()
        return waiter.reply or "reject"

    def reply(self, request_id: str, reply: str, message: str | None = None) -> bool:
        with self._lock:
            waiter = self._waiters.pop(request_id, None)
        if not waiter:
            return False
        if reply == "always":
            patterns = waiter.request.get("always") or waiter.request.get("patterns") or []
            for pattern in patterns:
                self._always_allowed.add(f"{waiter.request.get('permission')}:{pattern}")
        if message:
            waiter.request.setdefault("metadata", {})["userMessage"] = message
        waiter.reply = reply
        waiter.event.set()
        self._events.emit(
            {
                "type": "permission.replied",
                "properties": {
                    "sessionID": waiter.request.get("sessionID"),
                    "requestID": request_id,
                    "reply": reply,
                },
            }
        )
        return True


@dataclass(slots=True)
class _QuestionWaiter:
    request: dict[str, Any]
    event: threading.Event
    answers: list[list[str]] | None = None
    rejected: bool = False


class QuestionBroker:
    def __init__(self, events: EventBus) -> None:
        self._events = events
        self._waiters: dict[str, _QuestionWaiter] = {}
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [waiter.request for waiter in self._waiters.values()]

    def ask(self, request: dict[str, Any]) -> list[list[str]] | None:
        request_id = create_id("que")
        full_request = {**request, "id": request_id}
        waiter = _QuestionWaiter(full_request, threading.Event())
        with self._lock:
            self._waiters[request_id] = waiter
        self._events.emit({"type": "question.asked", "properties": full_request})
        waiter.event.wait()
        return None if waiter.rejected else waiter.answers or []

    def reply(self, request_id: str, answers: list[list[str]]) -> bool:
        with self._lock:
            waiter = self._waiters.pop(request_id, None)
        if not waiter:
            return False
        waiter.answers = answers
        waiter.event.set()
        self._events.emit(
            {
                "type": "question.replied",
                "properties": {
                    "sessionID": waiter.request.get("sessionID"),
                    "requestID": request_id,
                    "answers": answers,
                },
            }
        )
        return True

    def reject(self, request_id: str) -> bool:
        with self._lock:
            waiter = self._waiters.pop(request_id, None)
        if not waiter:
            return False
        waiter.rejected = True
        waiter.event.set()
        self._events.emit(
            {
                "type": "question.rejected",
                "properties": {
                    "sessionID": waiter.request.get("sessionID"),
                    "requestID": request_id,
                },
            }
        )
        return True
