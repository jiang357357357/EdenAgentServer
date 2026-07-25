from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from ..events import EventBus
from ..ids import create_id

PermissionReply = str
PermissionMode = str
DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300.0


@dataclass(slots=True)
class _PermissionWaiter:
    request: dict[str, Any]
    event: threading.Event
    reply: str | None = None


class PermissionBroker:
    def __init__(self, events: EventBus, timeout_seconds: float = DEFAULT_PERMISSION_TIMEOUT_SECONDS) -> None:
        self._events = events
        self._waiters: dict[str, _PermissionWaiter] = {}
        self._always_allowed: set[str] = set()
        self._mode: PermissionMode = "ask"
        self._timeout_seconds = max(0.01, float(timeout_seconds))
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [waiter.request for waiter in self._waiters.values()]

    def mode(self) -> dict[str, Any]:
        with self._lock:
            return {"mode": self._mode}

    def set_mode(self, mode: str) -> dict[str, Any]:
        next_mode = mode if mode in {"ask", "full_access"} else "ask"
        with self._lock:
            self._mode = next_mode
        self._events.emit({"type": "permission.mode", "properties": {"mode": next_mode}})
        return {"mode": next_mode}

    def is_always_allowed(self, permission: str, pattern: str) -> bool:
        with self._lock:
            if self._mode == "full_access":
                return True
            return f"{permission}:{pattern}" in self._always_allowed or f"{permission}:*" in self._always_allowed

    def ask(self, request: dict[str, Any]) -> str:
        request_id = create_id("per")
        full_request = {**request, "id": request_id, "always": request.get("always") or []}
        waiter = _PermissionWaiter(full_request, threading.Event())
        with self._lock:
            self._waiters[request_id] = waiter
        self._events.emit({"type": "permission.asked", "properties": full_request})
        answered = waiter.event.wait(timeout=self._timeout_seconds)
        if not answered:
            timed_out = False
            with self._lock:
                current = self._waiters.get(request_id)
                if current is waiter:
                    self._waiters.pop(request_id, None)
                    waiter.reply = "reject"
                    timed_out = True
            if timed_out:
                self._events.emit(
                    {
                        "type": "permission.replied",
                        "properties": {
                            "sessionID": waiter.request.get("sessionID"),
                            "requestID": request_id,
                            "reply": "reject",
                            "reason": "timeout",
                        },
                    }
                )
        return waiter.reply or "reject"

    def reject_all(self, session_id: str | None = None, reason: str = "cancelled") -> int:
        with self._lock:
            selected = [
                (request_id, waiter)
                for request_id, waiter in self._waiters.items()
                if session_id is None or waiter.request.get("sessionID") == session_id
            ]
            for request_id, waiter in selected:
                self._waiters.pop(request_id, None)
                waiter.reply = "reject"
        for request_id, waiter in selected:
            waiter.event.set()
            self._events.emit(
                {
                    "type": "permission.replied",
                    "properties": {
                        "sessionID": waiter.request.get("sessionID"),
                        "requestID": request_id,
                        "reply": "reject",
                        "reason": reason,
                    },
                }
            )
        return len(selected)

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


@dataclass(slots=True)
class _ScreenCaptureWaiter:
    request: dict[str, Any]
    event: threading.Event
    result: dict[str, Any] | None = None
    error: str | None = None


class ScreenCaptureBroker:
    def __init__(self, events: EventBus) -> None:
        self._events = events
        self._waiters: dict[str, _ScreenCaptureWaiter] = {}
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [waiter.request for waiter in self._waiters.values()]

    def capture(self, request: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
        request_id = create_id("cap")
        full_request = {**request, "id": request_id}
        waiter = _ScreenCaptureWaiter(full_request, threading.Event())
        with self._lock:
            self._waiters[request_id] = waiter
        self._events.emit({"type": "screen_capture.requested", "properties": full_request})
        if not waiter.event.wait(timeout):
            with self._lock:
                self._waiters.pop(request_id, None)
            self._events.emit(
                {
                    "type": "screen_capture.replied",
                    "properties": {
                        "sessionID": full_request.get("sessionID"),
                        "requestID": request_id,
                        "success": False,
                        "error": "桌面客户端截图响应超时",
                    },
                }
            )
            raise RuntimeError("桌面客户端未在 30 秒内返回屏幕截图。")
        if waiter.error:
            raise RuntimeError(waiter.error)
        if not waiter.result:
            raise RuntimeError("桌面客户端没有返回屏幕截图。")
        return waiter.result

    def reply(self, request_id: str, result: dict[str, Any] | None = None, error: str | None = None) -> bool:
        with self._lock:
            waiter = self._waiters.pop(request_id, None)
        if not waiter:
            return False
        waiter.result = result if isinstance(result, dict) else None
        waiter.error = str(error or "").strip() or None
        waiter.event.set()
        self._events.emit(
            {
                "type": "screen_capture.replied",
                "properties": {
                    "sessionID": waiter.request.get("sessionID"),
                    "requestID": request_id,
                    "success": waiter.error is None and waiter.result is not None,
                    "error": waiter.error,
                },
            }
        )
        return True
