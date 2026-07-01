from __future__ import annotations

import threading
from typing import Any

from .ids import create_id, now_ms


def _message_text(message: dict[str, Any]) -> str:
    return "\n".join(part.get("text", "") for part in message.get("parts", []) if part.get("type") == "text").strip()


def _title_from_messages(messages: list[dict[str, Any]]) -> str | None:
    for message in messages:
        if message.get("info", {}).get("role") != "user":
            continue
        text = _message_text(message)
        if text:
            return f"{text[:24]}..." if len(text) > 24 else text
    return None


def _to_agent_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for message in messages:
        text = _message_text(message)
        if not text:
            continue
        info = message.get("info", {})
        role = info.get("role")
        if role == "user":
            output.append({"role": "user", "timestamp": info.get("time", {}).get("created"), "content": [{"type": "text", "text": text}]})
        elif role == "assistant":
            output.append(
                {
                    "role": "assistant",
                    "timestamp": info.get("time", {}).get("created"),
                    "content": [{"type": "text", "text": text}],
                    "api": "openai-completions",
                    "provider": info.get("providerID") or "openai",
                    "model": info.get("modelID") or "unknown",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 0,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
                    },
                    "stopReason": "error" if info.get("error") else "stop",
                    "errorMessage": (info.get("error") or {}).get("message"),
                }
            )
    return output


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def list_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            sessions = [session["info"] for session in self._sessions.values()]
        return sorted(sessions, key=lambda item: item["time"]["updated"], reverse=True)[:limit]

    def create_session(self, title: str = "") -> dict[str, Any]:
        current = now_ms()
        info = {"id": create_id("ses"), "title": title or "新会话", "time": {"created": current, "updated": current}}
        with self._lock:
            self._sessions[info["id"]] = {"info": info, "messages": [], "agentMessages": []}
        return info

    def upsert_session_info(self, info: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            existing = self._sessions.get(info["id"], {})
            existing_info = existing.get("info", {})
            merged = {
                **existing_info,
                **info,
                "time": {**existing_info.get("time", {}), **info.get("time", {})},
            }
            self._sessions[info["id"]] = {
                "info": merged,
                "messages": existing.get("messages", []),
                "agentMessages": existing.get("agentMessages", []),
            }
            return merged

    def require_session(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                raise KeyError(f"Session not found: {session_id}")
            return session

    def list_messages(self, session_id: str, limit: int = 100) -> list[dict[str, Any]]:
        session = self.require_session(session_id)
        with self._lock:
            return list(session["messages"][-limit:])

    def hydrate_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            session = self.require_session(session_id)
            session["messages"] = sorted(messages, key=lambda item: item.get("info", {}).get("time", {}).get("created", 0))
            session["agentMessages"] = _to_agent_messages(session["messages"])
            latest = max((item.get("info", {}).get("time", {}).get("created", 0) for item in session["messages"]), default=0)
            if latest:
                session["info"]["time"]["updated"] = max(session["info"]["time"]["updated"], latest)
            if not session["info"].get("title") or session["info"].get("title") == "新会话":
                title = _title_from_messages(session["messages"])
                if title:
                    session["info"]["title"] = title

    def upsert_message(self, session_id: str, info: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            for message in session["messages"]:
                if message["info"]["id"] == info["id"]:
                    message["info"] = {**message["info"], **info, "time": {**message["info"].get("time", {}), **info.get("time", {})}}
                    self._touch(session)
                    return message
            message = {"info": info, "parts": []}
            session["messages"].append(message)
            self._touch(session)
            return message

    def upsert_part(self, session_id: str, part: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            message = next((item for item in session["messages"] if item["info"]["id"] == part["messageID"]), None)
            if not message:
                message = self.upsert_message(
                    session_id,
                    {"id": part["messageID"], "role": "assistant", "time": {"created": now_ms()}},
                )
            for index, existing in enumerate(message["parts"]):
                if existing["id"] == part["id"]:
                    message["parts"][index] = part
                    return part
            message["parts"].append(part)
            self._touch(session)
            return part

    def append_user_message(self, session_id: str, text: str, files: list[dict[str, Any]]) -> dict[str, Any]:
        current = now_ms()
        message_id = create_id("msg")
        parts: list[dict[str, Any]] = []
        if text.strip():
            parts.append(
                {
                    "id": f"{message_id}_text_0",
                    "messageID": message_id,
                    "sessionID": session_id,
                    "type": "text",
                    "text": text,
                    "time": {"start": current, "end": current},
                }
            )
        for index, file in enumerate(files):
            parts.append(
                {
                    "id": f"{message_id}_file_{index}",
                    "messageID": message_id,
                    "sessionID": session_id,
                    "type": "file",
                    "mime": file.get("mime") or "application/octet-stream",
                    "url": file.get("url") or "",
                    "filename": file.get("filename"),
                }
            )
        message = {"info": {"id": message_id, "role": "user", "time": {"created": current, "completed": current}}, "parts": parts}
        with self._lock:
            session = self.require_session(session_id)
            session["messages"].append(message)
            self._touch(session)
        return message

    def set_agent_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            session = self.require_session(session_id)
            session["agentMessages"] = messages
            self._touch(session)

    def _touch(self, session: dict[str, Any]) -> None:
        session["info"]["time"]["updated"] = now_ms()
        if not session["info"].get("title") or session["info"].get("title") == "新会话":
            title = _title_from_messages(session["messages"])
            if title:
                session["info"]["title"] = title
