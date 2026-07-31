from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from ..events import EventBus
from ..ids import create_id

PermissionReply = str
PermissionMode = str
DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300.0
PERMISSION_MODES = frozenset({"restricted", "full_access", "takeover"})


def normalize_permission_mode(mode: str | None) -> PermissionMode:
    # Compatibility with settings persisted before the three-level policy.
    return "restricted" if mode == "ask" else mode if mode in PERMISSION_MODES else "restricted"


@dataclass(slots=True)
class _PermissionWaiter:
    request: dict[str, Any]
    event: threading.Event
    reply: str | None = None


class PermissionBroker:
    def __init__(self, events: EventBus, timeout_seconds: float = DEFAULT_PERMISSION_TIMEOUT_SECONDS) -> None:
        self._events = events
        self._waiters: dict[str, _PermissionWaiter] = {}
        self._always_allowed: set[tuple[str | None, str, str]] = set()
        self._mode: PermissionMode = "restricted"
        self._scoped_modes: dict[str, PermissionMode] = {}
        self._session_scopes: dict[str, str] = {}
        self._timeout_seconds = max(0.01, float(timeout_seconds))
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [waiter.request for waiter in self._waiters.values()]

    def mode(self, scope: str | None = None) -> dict[str, Any]:
        with self._lock:
            return {"mode": self._scoped_modes.get(scope, self._mode) if scope else self._mode}

    def hydrate_mode(self, mode: str, scope: str | None = None, session_id: str | None = None) -> dict[str, Any]:
        next_mode = normalize_permission_mode(mode)
        with self._lock:
            if scope:
                self._scoped_modes[scope] = next_mode
                if session_id:
                    self._session_scopes[session_id] = scope
            else:
                self._mode = next_mode
        return {"mode": next_mode}

    def set_mode(self, mode: str, scope: str | None = None) -> dict[str, Any]:
        result = self.hydrate_mode(mode, scope)
        next_mode = result["mode"]
        self._events.emit({"type": "permission.mode", "properties": {"mode": next_mode}})
        return result

    def bind_session(self, session_id: str, scope: str) -> None:
        with self._lock:
            self._session_scopes[session_id] = scope

    def mode_for_session(self, session_id: str | None = None) -> PermissionMode:
        with self._lock:
            scope = self._session_scopes.get(session_id) if session_id else None
            return self._scoped_modes.get(scope, self._mode) if scope else self._mode

    def is_explicitly_allowed(self, permission: str, pattern: str, session_id: str | None = None) -> bool:
        with self._lock:
            return (
                (session_id, permission, pattern) in self._always_allowed
                or (session_id, permission, "*") in self._always_allowed
                or (None, permission, pattern) in self._always_allowed
                or (None, permission, "*") in self._always_allowed
            )

    def is_always_allowed(self, permission: str, pattern: str, session_id: str | None = None) -> bool:
        with self._lock:
            scope = self._session_scopes.get(session_id) if session_id else None
            mode = self._scoped_modes.get(scope, self._mode) if scope else self._mode
            if mode == "takeover":
                return True
            return (
                (session_id, permission, pattern) in self._always_allowed
                or (session_id, permission, "*") in self._always_allowed
                or (None, permission, pattern) in self._always_allowed
                or (None, permission, "*") in self._always_allowed
            )

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
                    self._always_allowed.add(
                        (waiter.request.get("sessionID"), str(waiter.request.get("permission")), str(pattern))
                    )
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
class _CaptureWaiter:
    request: dict[str, Any]
    event: threading.Event
    result: dict[str, Any] | None = None
    error: str | None = None


class CaptureBroker:
    def __init__(
        self,
        events: EventBus,
        *,
        event_prefix: str,
        timeout_message: str,
        missing_result_message: str,
    ) -> None:
        self._events = events
        self._event_prefix = event_prefix
        self._timeout_message = timeout_message
        self._missing_result_message = missing_result_message
        self._waiters: dict[str, _CaptureWaiter] = {}
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [waiter.request for waiter in self._waiters.values()]

    def capture(self, request: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
        request_id = create_id("cap")
        full_request = {**request, "id": request_id}
        waiter = _CaptureWaiter(full_request, threading.Event())
        with self._lock:
            self._waiters[request_id] = waiter
        self._events.emit({"type": f"{self._event_prefix}.requested", "properties": full_request})
        if not waiter.event.wait(timeout):
            with self._lock:
                self._waiters.pop(request_id, None)
            self._events.emit(
                {
                    "type": f"{self._event_prefix}.replied",
                    "properties": {
                        "sessionID": full_request.get("sessionID"),
                        "requestID": request_id,
                        "success": False,
                        "error": self._timeout_message,
                    },
                }
            )
            raise RuntimeError(self._timeout_message)
        if waiter.error:
            raise RuntimeError(waiter.error)
        if not waiter.result:
            raise RuntimeError(self._missing_result_message)
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
                "type": f"{self._event_prefix}.replied",
                "properties": {
                    "sessionID": waiter.request.get("sessionID"),
                    "requestID": request_id,
                    "success": waiter.error is None and waiter.result is not None,
                    "error": waiter.error,
                },
            }
        )
        return True

    def reject_all(self, session_id: str | None = None, reason: str = "capture_cancelled") -> int:
        with self._lock:
            selected = [
                (request_id, waiter)
                for request_id, waiter in self._waiters.items()
                if session_id is None or waiter.request.get("sessionID") == session_id
            ]
            for request_id, waiter in selected:
                self._waiters.pop(request_id, None)
                waiter.error = reason
        for request_id, waiter in selected:
            waiter.event.set()
            self._events.emit(
                {
                    "type": f"{self._event_prefix}.replied",
                    "properties": {
                        "sessionID": waiter.request.get("sessionID"),
                        "requestID": request_id,
                        "success": False,
                        "error": reason,
                    },
                }
            )
        return len(selected)


class ScreenCaptureBroker(CaptureBroker):
    def __init__(self, events: EventBus) -> None:
        super().__init__(
            events,
            event_prefix="screen_capture",
            timeout_message="桌面客户端未在 30 秒内返回屏幕截图。",
            missing_result_message="桌面客户端没有返回屏幕截图。",
        )


class CameraCaptureBroker(CaptureBroker):
    def __init__(self, events: EventBus) -> None:
        super().__init__(
            events,
            event_prefix="camera_capture",
            timeout_message="客户端未在 30 秒内返回摄像头画面。",
            missing_result_message="客户端没有返回摄像头画面。",
        )
